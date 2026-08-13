import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerEnv } from '@online-learning/config'
import { Prisma, type PrismaClient } from '@online-learning/database'
import type { MultipartStorageProvider, StoredObject } from '@online-learning/storage'
import { MossError, type MossAdapter, type MossResult } from '../moss/adapter'
import { parseSilenceCenters, planAudioChunks } from '../transcript/chunks'
import { G3_PIPELINE_VERSION } from '../transcript/constants'
import { mergeChunkResults, segmentTranscript, TranscriptValidationError } from '../transcript/merge'

const execFileAsync = promisify(execFile)
const noProxyEnvironment = {
  ...process.env,
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
}

export type TranscriptJob = { mediaAssetId: string; processingRunId: string }

class TranscriptLeaseLostError extends Error {}

export async function cancelExternalTranscriptJobs(
  database: PrismaClient,
  moss: MossAdapter,
  job: TranscriptJob,
  now = new Date(),
  lookupGraceMs = 6 * 60 * 60_000,
) {
  const run = await database.processingRun.findFirst({
    where: {
      id: job.processingRunId, mediaAssetId: job.mediaAssetId,
      status: { in: ['CANCELLED', 'FAILED'] },
    },
    select: { id: true, status: true },
  })
  if (!run) return { skipped: true, cancelled: 0 }
  const chunks = await database.processingChunk.findMany({
    where: {
      processingRunId: run.id, externalCancelledAt: null,
      ...(run.status === 'FAILED' ? { status: 'FAILED' as const, errorCode: 'moss_timeout' } : {}),
    },
    select: { id: true, externalJobId: true, idempotencyKey: true, submittedAt: true },
  })
  let cancelled = 0
  for (const chunk of chunks) {
    let externalJobId = chunk.externalJobId
    if (!externalJobId) {
      const recovered = await moss.findByIdempotencyKey(chunk.idempotencyKey)
      if (!recovered) {
        const lookupStillAmbiguous = chunk.submittedAt !== null
          && now.getTime() - chunk.submittedAt.getTime() < lookupGraceMs
        if (lookupStillAmbiguous) continue
        const confirmed = await database.processingChunk.updateMany({
          where: { id: chunk.id, externalJobId: null, externalCancelledAt: null },
          data: { externalCancelledAt: now },
        })
        cancelled += confirmed.count
        continue
      }
      const adopted = await database.processingChunk.updateMany({
        where: { id: chunk.id, externalJobId: null, externalCancelledAt: null },
        data: { externalJobId: recovered.externalJobId },
      })
      if (adopted.count !== 1) continue
      externalJobId = recovered.externalJobId
    }
    await moss.cancel(externalJobId)
    const changed = await database.processingChunk.updateMany({
      where: { id: chunk.id, externalJobId, externalCancelledAt: null },
      data: { externalCancelledAt: now },
    })
    cancelled += changed.count
  }
  return { skipped: false, cancelled }
}

type TranscriptProcessorOptions = {
  database: PrismaClient
  storage: MultipartStorageProvider
  moss: MossAdapter
  env: ServerEnv
  workerId: string
  now?: () => Date
}

async function checksum(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function runFfmpeg(ffmpegPath: string, args: string[], timeout: number) {
  try {
    return await execFileAsync(ffmpegPath, args, {
      windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024, env: noProxyEnvironment,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'ffmpeg_failed'
    throw new Error(message)
  }
}

function retryAt(now: Date, attempt: number) {
  const base = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(attempt, 8)))
  return new Date(now.getTime() + Math.round(base * (0.75 + Math.random() * 0.5)))
}

function recordMetadata(value: Prisma.JsonValue | null) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function createTranscriptProcessor(options: TranscriptProcessorOptions) {
  const now = options.now ?? (() => new Date())

  async function assertLease(runId: string) {
    const run = await options.database.processingRun.findFirst({
      where: {
        id: runId, status: 'PROCESSING', leaseOwner: options.workerId,
        leaseExpiresAt: { gt: now() },
      },
      select: { id: true },
    })
    if (!run) throw new TranscriptLeaseLostError('transcript_lease_lost')
  }

  function isMissingObject(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error
      && ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(String((error as { code?: unknown }).code))
  }

  async function uploadTrackedObject(
    runId: string,
    mediaAssetId: string,
    kind: 'NORMALIZED_AUDIO' | 'AUDIO_CHUNK' | 'ASR_RAW',
    objectKey: string,
    filePath: string,
    contentType: string,
    checksumSha256: string,
    metadata: Record<string, Prisma.InputJsonValue>,
  ) {
    const expectedSize = (await stat(filePath)).size
    const objectIdentity = `${options.storage.bucket}:${objectKey}`
    // Reserve the stable identity in a short independent transaction. Do not nest this
    // transaction inside the long object-store transaction: production pools must also
    // work with a single available connection.
    const record = await options.database.$transaction(async (reservation) => {
      await reservation.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
      const active = await reservation.processingRun.findFirst({
        where: {
          id: runId, mediaAssetId, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        select: { id: true },
      })
      if (!active) throw new TranscriptLeaseLostError('transcript_lease_lost')
      const records = await reservation.mediaObject.findMany({
        where: { mediaAssetId, bucket: options.storage.bucket, objectKey },
        orderBy: { createdAt: 'desc' },
      })
      const current = records.find((candidate) => candidate.versionId === null) ?? records[0]
      if (current && current.kind !== kind) throw new Error('tracked_object_identity_conflict')
      if (!current) {
        return reservation.mediaObject.create({
          data: {
            mediaAssetId, kind, bucket: options.storage.bucket, objectKey, versionId: null,
            contentType, sizeBytes: BigInt(expectedSize), checksumSha256,
            metadata: { ...metadata, uploadState: 'PENDING' },
          },
        })
      }
      return reservation.mediaObject.update({
        where: { id: current.id },
        data: {
          kind, versionId: null, contentType, sizeBytes: BigInt(expectedSize), checksumSha256, etag: null,
          deletedAt: null, purgedAt: null, metadata: { ...metadata, uploadState: 'PENDING' },
        },
      })
    }, { maxWait: 10_000, timeout: 30_000 })

    return options.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
      const active = await transaction.processingRun.findFirst({
        where: {
          id: runId, mediaAssetId, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        select: { id: true },
      })
      if (!active) throw new TranscriptLeaseLostError('transcript_lease_lost')

      let object: StoredObject | null = null
      let uploadedByThisAttempt: StoredObject | null = null
      try {
        try {
          const existing = await options.storage.statObject(objectKey, null)
          if (existing.sizeBytes === expectedSize) {
            const verificationPath = `${filePath}.remote-${randomUUID()}`
            try {
              await options.storage.downloadFile(objectKey, verificationPath, existing.versionId)
              if (await checksum(await readFile(verificationPath)) === checksumSha256) object = existing
            } finally {
              await rm(verificationPath, { force: true })
            }
          }
          if (!object) await options.storage.remove(objectKey, existing.versionId)
        } catch (error) {
          if (!isMissingObject(error)) throw error
        }
        if (!object) {
          uploadedByThisAttempt = await options.storage.uploadFile(objectKey, filePath, contentType)
          object = uploadedByThisAttempt
        }
        if (object.sizeBytes !== expectedSize) throw new Error('tracked_object_size_mismatch')

        const fenced = await transaction.processingRun.updateMany({
          where: {
            id: runId, mediaAssetId, status: 'PROCESSING', leaseOwner: options.workerId,
            leaseExpiresAt: { gt: now() },
          },
          data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
        })
        if (fenced.count !== 1) {
          if (uploadedByThisAttempt) {
            await options.storage.remove(uploadedByThisAttempt.objectKey, uploadedByThisAttempt.versionId).catch(() => undefined)
          }
          throw new TranscriptLeaseLostError('tracked_object_fence_lost')
        }
        await transaction.mediaObject.update({
          where: { id: record.id },
          data: {
            versionId: object.versionId, contentType: object.contentType ?? contentType,
            sizeBytes: BigInt(object.sizeBytes), etag: object.etag, checksumSha256,
            metadata: { ...metadata, uploadState: 'READY' },
          },
        })
        return object
      } catch (error) {
        // Do not remove after releasing the advisory lock: a replacement could already
        // have adopted that version. The durable PENDING row makes unknown outcomes recoverable.
        throw error
      }
    }, { maxWait: 10 * 60_000, timeout: 30 * 60_000 })
  }

  async function prepareAudio(run: {
    id: string
    mediaAssetId: string
    mediaAsset: {
      ownerId: string
      durationMs: number | null
      objects: Array<{ id: string; objectKey: string; versionId: string | null; etag: string | null }>
    }
  }, directory: string) {
    const durationMs = run.mediaAsset.durationMs
    const source = run.mediaAsset.objects[0]
    if (!durationMs || !source) throw new Error('media_object_missing')
    const existingChunks = await options.database.processingChunk.count({ where: { processingRunId: run.id } })
    if (existingChunks > 0) {
      const resumed = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'TRANSCRIBING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (resumed.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return
    }

    const extracting = await options.database.processingRun.updateMany({
      where: {
        id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
        leaseExpiresAt: { gt: now() },
      },
      data: { stage: 'AUDIO_EXTRACTING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    })
    if (extracting.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
    const sourcePath = join(directory, 'source.mp4')
    const normalizedPath = join(directory, 'normalized.wav')
    const stagedObjects = await options.database.mediaObject.findMany({
      where: {
        mediaAssetId: run.mediaAssetId, kind: { in: ['NORMALIZED_AUDIO', 'AUDIO_CHUNK'] }, deletedAt: null,
        metadata: { path: ['processingRunId'], equals: run.id },
      },
      orderBy: { createdAt: 'desc' },
    })
    const stagedNormalized = stagedObjects.find((object) => object.kind === 'NORMALIZED_AUDIO')
    let normalizedReady = false
    if (stagedNormalized?.checksumSha256) {
      try {
        await options.storage.downloadFile(stagedNormalized.objectKey, normalizedPath, stagedNormalized.versionId)
        normalizedReady = await checksum(await readFile(normalizedPath)) === stagedNormalized.checksumSha256
      } catch (error) {
        if (!isMissingObject(error)) throw error
      }
    }
    const normalizedKey = `owners/${run.mediaAsset.ownerId}/audio/${run.mediaAssetId}/${run.id}/normalized.wav`
    if (!normalizedReady) {
      await options.storage.downloadFile(source.objectKey, sourcePath, source.versionId)
      await runFfmpeg(options.env.FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', normalizedPath,
      ], 6 * 60 * 60_000)
    }
    const normalizedChecksum = await checksum(await readFile(normalizedPath))
    await uploadTrackedObject(run.id, run.mediaAssetId, 'NORMALIZED_AUDIO', normalizedKey, normalizedPath, 'audio/wav', normalizedChecksum, {
      processingRunId: run.id, sourceObjectId: source.id, expiresAfter: 'terminal+24h',
    })

    const chunking = await options.database.processingRun.updateMany({
      where: {
        id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
        leaseExpiresAt: { gt: now() },
      },
      data: { stage: 'CHUNKING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    })
    if (chunking.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
    const silence = await runFfmpeg(options.env.FFMPEG_PATH, [
      '-hide_banner', '-i', normalizedPath, '-af', 'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-',
    ], 6 * 60 * 60_000).then((output) => parseSilenceCenters(output.stderr)).catch(() => [])
    const plan = planAudioChunks(
      durationMs,
      options.env.MOSS_CHUNK_TARGET_SECONDS * 1000,
      options.env.MOSS_CHUNK_OVERLAP_SECONDS * 1000,
      silence,
    )
    const uploaded: Array<{ plan: (typeof plan)[number]; object: { objectKey: string; versionId: string | null } }> = []
    for (const chunk of plan) {
      await assertLease(run.id)
      const staged = stagedObjects.find((object) => {
        if (object.kind !== 'AUDIO_CHUNK') return false
        const metadata = recordMetadata(object.metadata)
        return metadata.chunkIndex === chunk.chunkIndex && metadata.startMs === chunk.startMs && metadata.endMs === chunk.endMs
      })
      const chunkPath = join(directory, `chunk-${String(chunk.chunkIndex).padStart(4, '0')}.wav`)
      let stagedReady = false
      if (staged) {
        try {
          await options.storage.downloadFile(staged.objectKey, chunkPath, staged.versionId)
          stagedReady = Boolean(staged.checksumSha256)
            && await checksum(await readFile(chunkPath)) === staged.checksumSha256
        } catch (error) {
          if (!isMissingObject(error)) throw error
        }
      }
      if (!stagedReady) {
        await runFfmpeg(options.env.FFMPEG_PATH, [
          '-hide_banner', '-loglevel', 'error', '-ss', String(chunk.startMs / 1000),
          '-t', String((chunk.endMs - chunk.startMs) / 1000), '-i', normalizedPath,
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', chunkPath,
        ], 2 * 60 * 60_000)
      }
      const key = `owners/${run.mediaAsset.ownerId}/audio/${run.mediaAssetId}/${run.id}/chunks/${String(chunk.chunkIndex).padStart(4, '0')}.wav`
      const chunkChecksum = await checksum(await readFile(chunkPath))
      const object = await uploadTrackedObject(run.id, run.mediaAssetId, 'AUDIO_CHUNK', key, chunkPath, 'audio/wav', chunkChecksum, {
        processingRunId: run.id, chunkIndex: chunk.chunkIndex, startMs: chunk.startMs,
        endMs: chunk.endMs, expiresAfter: 'terminal+24h',
      })
      uploaded.push({
        plan: chunk, object: { objectKey: object.objectKey, versionId: object.versionId },
      })
    }
    const sourceVersion = source.versionId ?? source.etag ?? source.id
    await options.database.$transaction(async (transaction) => {
      const fenced = await transaction.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'TRANSCRIBING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (fenced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      for (const item of uploaded) {
        const identity = createHash('sha256').update([
          sourceVersion, G3_PIPELINE_VERSION, 'TRANSCRIBING', item.plan.chunkIndex, options.env.MOSS_MODEL_VERSION,
        ].join('|')).digest('hex')
        await transaction.processingChunk.create({
          data: {
            processingRunId: run.id, chunkIndex: item.plan.chunkIndex,
            startMs: item.plan.startMs, endMs: item.plan.endMs,
            idempotencyKey: `g3:${identity}`, modelVersion: options.env.MOSS_MODEL_VERSION,
            inputObjectKey: item.object.objectKey, inputVersionId: item.object.versionId,
          },
        })
      }
    }, { maxWait: 10_000, timeout: 60_000 })
  }

  async function completeChunk(run: { id: string; mediaAssetId: string; mediaAsset: { ownerId: string } }, chunk: {
    id: string; chunkIndex: number; startMs: number; endMs: number; externalJobId: string; idempotencyKey: string
  }, result: MossResult, directory: string) {
    const bytes = Buffer.from(JSON.stringify(result))
    const resultChecksum = await checksum(bytes)
    const path = join(directory, `result-${String(chunk.chunkIndex).padStart(4, '0')}.json`)
    await writeFile(path, bytes)
    const key = `owners/${run.mediaAsset.ownerId}/asr/${run.mediaAssetId}/${run.id}/${String(chunk.chunkIndex).padStart(4, '0')}.json`
    const object = await uploadTrackedObject(run.id, run.mediaAssetId, 'ASR_RAW', key, path, 'application/json', resultChecksum, {
      processingRunId: run.id, chunkIndex: chunk.chunkIndex, externalJobId: chunk.externalJobId,
      idempotencyKey: chunk.idempotencyKey, resultChecksum, immutable: true, expiresAfter: 'fetched+7d',
    })
    await options.database.$transaction(async (transaction) => {
      const runFence = await transaction.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      const fenced = await transaction.processingChunk.updateMany({
        where: {
          id: chunk.id, status: 'PROCESSING', externalJobId: chunk.externalJobId,
          leaseOwner: options.workerId, leaseExpiresAt: { gt: now() },
        },
        data: {
          status: 'SUCCEEDED', resultObjectKey: object.objectKey, resultVersionId: object.versionId,
          resultChecksum, wordCount: result.words.length, completedAt: now(), nextPollAt: null,
          leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorDetail: Prisma.DbNull,
        },
      })
      if (fenced.count !== 1) throw new TranscriptLeaseLostError('transcript_chunk_fence_lost')
    })
  }

  async function transcribe(run: {
    id: string; mediaAssetId: string; mediaAsset: { ownerId: string }
  }, directory: string) {
    let chunks = await options.database.processingChunk.findMany({
      where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' },
    })
    for (const chunk of chunks) {
      if (chunk.status === 'SUCCEEDED' || chunk.status === 'CANCELLED' || chunk.status === 'FAILED') continue
      const chunkLeaseExpiresAt = new Date(now().getTime() + 5 * 60_000)
      const claimed = await options.database.processingChunk.updateMany({
        where: {
          id: chunk.id, status: { in: ['QUEUED', 'PROCESSING'] },
          OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now() } }],
        },
        data: { leaseOwner: options.workerId, leaseExpiresAt: chunkLeaseExpiresAt },
      })
      if (claimed.count !== 1) continue
      const ownedChunk = await options.database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })
      try {
        if (!ownedChunk.externalJobId) {
          const submissionStartedAt = ownedChunk.submittedAt ?? now()
          if (!ownedChunk.submittedAt) {
            await options.database.$transaction(async (transaction) => {
              const runFence = await transaction.processingRun.updateMany({
                where: {
                  id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
                  leaseExpiresAt: { gt: now() },
                },
                data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
              })
              if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
              const marked = await transaction.processingChunk.updateMany({
                where: {
                  id: ownedChunk.id, status: 'QUEUED', externalJobId: null, submittedAt: null,
                  leaseOwner: options.workerId, leaseExpiresAt: { gt: now() },
                },
                data: { submittedAt: submissionStartedAt },
              })
              if (marked.count !== 1) throw new TranscriptLeaseLostError('transcript_submit_fence_lost')
            })
          }
          const audioUrl = await options.storage.createReadUrl(
            ownedChunk.inputObjectKey, options.env.MOSS_AUDIO_URL_TTL_SECONDS, ownedChunk.inputVersionId,
          )
          const submitted = await options.moss.submit({
            idempotencyKey: ownedChunk.idempotencyKey,
            audioUrl,
            callbackUrl: options.env.MOSS_CALLBACK_PUBLIC_URL!,
            language: 'en', modelVersion: ownedChunk.modelVersion,
            chunkIndex: ownedChunk.chunkIndex, startMs: ownedChunk.startMs, endMs: ownedChunk.endMs,
          })
          const persisted = await options.database.processingChunk.updateMany({
            where: {
              id: ownedChunk.id, status: 'QUEUED', externalJobId: null,
              leaseOwner: options.workerId, leaseExpiresAt: { gt: now() },
            },
            data: {
              status: 'PROCESSING', externalJobId: submitted.externalJobId, submittedAt: submissionStartedAt,
              nextPollAt: new Date(now().getTime() + options.env.MOSS_POLL_INTERVAL_SECONDS * 1000),
              leaseOwner: null, leaseExpiresAt: null,
            },
          })
          if (persisted.count !== 1) {
            const adoptedCancellation = await options.database.processingChunk.updateMany({
              where: { id: ownedChunk.id, status: 'CANCELLED', externalJobId: null },
              data: { externalJobId: submitted.externalJobId },
            })
            const reconciled = adoptedCancellation.count === 0
              ? await options.database.processingChunk.updateMany({
                  where: {
                    id: ownedChunk.id, status: { in: ['QUEUED', 'PROCESSING'] }, externalJobId: null,
                    idempotencyKey: submitted.idempotencyKey,
                  },
                  data: {
                    status: 'PROCESSING', externalJobId: submitted.externalJobId, submittedAt: submissionStartedAt,
                    nextPollAt: new Date(now().getTime() + options.env.MOSS_POLL_INTERVAL_SECONDS * 1000),
                  },
                })
              : { count: 0 }
            const latest = await options.database.processingChunk.findUnique({
              where: { id: ownedChunk.id }, select: { status: true, externalJobId: true },
            }
            )
            const mustCancel = !latest || latest.status === 'CANCELLED'
              || (latest.externalJobId !== null && latest.externalJobId !== submitted.externalJobId)
            let cancelled = false
            if (mustCancel) {
              try {
                await options.moss.cancel(submitted.externalJobId)
                cancelled = true
              } catch {
                // A cancelled chunk with a persisted id is recovered by the cancellation scanner.
              }
            }
            if (adoptedCancellation.count === 1 && cancelled) {
              await options.database.processingChunk.updateMany({
                where: { id: ownedChunk.id, status: 'CANCELLED', externalJobId: submitted.externalJobId },
                data: { externalCancelledAt: now() },
              })
            }
            if (reconciled.count === 0 && adoptedCancellation.count === 0 && !latest) {
              throw new TranscriptLeaseLostError('transcript_chunk_deleted_after_submit')
            }
          }
          continue
        }
        if (ownedChunk.nextPollAt && ownedChunk.nextPollAt.getTime() > now().getTime()) {
          await options.database.processingChunk.updateMany({
            where: {
              id: ownedChunk.id, leaseOwner: options.workerId,
              leaseExpiresAt: { gt: now() },
            },
            data: { leaseOwner: null, leaseExpiresAt: null },
          })
          continue
        }
        if (ownedChunk.submittedAt && now().getTime() - ownedChunk.submittedAt.getTime() > options.env.MOSS_JOB_TIMEOUT_SECONDS * 1000) {
          let cancelled = false
          try {
            await options.moss.cancel(ownedChunk.externalJobId)
            cancelled = true
          } catch {
            // Persist the external id and leave cancellation unconfirmed for the recovery scanner.
          }
          await options.database.processingChunk.updateMany({
            where: {
              id: ownedChunk.id, leaseOwner: options.workerId,
              leaseExpiresAt: { gt: now() },
            },
            data: {
              status: 'FAILED', errorCode: 'moss_timeout', failedAt: now(), nextPollAt: null,
              externalCancelledAt: cancelled ? now() : null, leaseOwner: null, leaseExpiresAt: null,
            },
          })
          continue
        }
        const external = await options.moss.query(ownedChunk.externalJobId)
        if (external.status === 'queued' || external.status === 'processing') {
          await options.database.processingChunk.updateMany({
            where: {
              id: ownedChunk.id, leaseOwner: options.workerId,
              leaseExpiresAt: { gt: now() },
            },
            data: {
              nextPollAt: new Date(now().getTime() + options.env.MOSS_POLL_INTERVAL_SECONDS * 1000),
              leaseOwner: null, leaseExpiresAt: null,
            },
          })
          continue
        }
        if (external.status === 'failed' || external.status === 'cancelled') {
          await options.database.processingChunk.updateMany({
            where: {
              id: ownedChunk.id, leaseOwner: options.workerId,
              leaseExpiresAt: { gt: now() },
            },
            data: {
              status: 'FAILED', errorCode: external.errorCode ?? 'moss_rejected', failedAt: now(), nextPollAt: null,
              leaseOwner: null, leaseExpiresAt: null,
            },
          })
          continue
        }
        await completeChunk(run, {
          id: ownedChunk.id, chunkIndex: ownedChunk.chunkIndex, startMs: ownedChunk.startMs, endMs: ownedChunk.endMs,
          externalJobId: ownedChunk.externalJobId, idempotencyKey: ownedChunk.idempotencyKey,
        }, await options.moss.result(ownedChunk.externalJobId), directory)
      } catch (error) {
        if (error instanceof TranscriptLeaseLostError) throw error
        const attempt = ownedChunk.attempt + 1
        const normalized = error instanceof MossError ? error : new MossError('moss_unavailable', 'MOSS operation failed', true)
        const terminal = !normalized.retryable || attempt >= options.env.MOSS_MAX_ATTEMPTS
        await options.database.processingChunk.updateMany({
          where: {
            id: ownedChunk.id, status: { in: ['QUEUED', 'PROCESSING'] }, leaseOwner: options.workerId,
            leaseExpiresAt: { gt: now() },
          },
          data: {
            status: terminal ? 'FAILED' : ownedChunk.externalJobId ? 'PROCESSING' : 'QUEUED',
            attempt, errorCode: normalized.code, errorDetail: { retryable: normalized.retryable },
            failedAt: terminal ? now() : null, nextPollAt: terminal ? null : retryAt(now(), attempt),
            leaseOwner: null, leaseExpiresAt: null,
          },
        })
      }
    }
    chunks = await options.database.processingChunk.findMany({ where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' } })
    const failed = chunks.find((chunk) => chunk.status === 'FAILED' || chunk.status === 'CANCELLED')
    if (failed) {
      const failedRun = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: {
          status: 'FAILED', failedAt: now(), errorCode: failed.errorCode ?? 'transcript_incomplete',
          errorDetail: { failedChunkIndex: failed.chunkIndex }, leaseOwner: null, leaseExpiresAt: null,
        },
      })
      if (failedRun.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return false
    }
    if (!chunks.length || chunks.some((chunk) => chunk.status !== 'SUCCEEDED')) {
      const released = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: { leaseOwner: null, leaseExpiresAt: null },
      })
      if (released.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return false
    }
    const advanced = await options.database.processingRun.updateMany({
      where: {
        id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
        leaseExpiresAt: { gt: now() },
      },
      data: { stage: 'MERGING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    })
    if (advanced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
    return true
  }

  async function publish(run: {
    id: string; ownerId: string; mediaAssetId: string; pipelineVersion: string
    mediaAsset: { ownerId: string; title: string; durationMs: number | null }
  }, directory: string) {
    if (!run.mediaAsset.durationMs) throw new TranscriptValidationError('transcript_timing_invalid', 'media duration is unavailable')
    const chunks = await options.database.processingChunk.findMany({
      where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' },
    })
    const modelVersions = new Set(chunks.map((chunk) => chunk.modelVersion))
    if (modelVersions.size !== 1) {
      throw new TranscriptValidationError('transcript_incomplete', 'required chunks do not share one model version')
    }
    const modelVersion = [...modelVersions][0]
    const results = []
    for (const chunk of chunks) {
      if (chunk.status !== 'SUCCEEDED' || !chunk.resultObjectKey || !chunk.resultChecksum) {
        throw new TranscriptValidationError('transcript_incomplete', 'not every required chunk succeeded')
      }
      const path = join(directory, `merge-${String(chunk.chunkIndex).padStart(4, '0')}.json`)
      await options.storage.downloadFile(chunk.resultObjectKey, path, chunk.resultVersionId)
      const bytes = await readFile(path)
      if (await checksum(bytes) !== chunk.resultChecksum) throw new TranscriptValidationError('transcript_incomplete', 'ASR result checksum mismatch')
      results.push({ chunkIndex: chunk.chunkIndex, startMs: chunk.startMs, endMs: chunk.endMs, result: JSON.parse(bytes.toString('utf8')) as MossResult })
    }
    const words = mergeChunkResults(results, run.mediaAsset.durationMs)
    const stage = await options.database.processingRun.findUniqueOrThrow({
      where: { id: run.id }, select: { stage: true },
    })
    if (stage.stage === 'MERGING') {
      const segmenting = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', stage: 'MERGING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'CUE_SEGMENTING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (segmenting.count !== 1) throw new TranscriptLeaseLostError('transcript_segment_fence_lost')
    } else if (!['CUE_SEGMENTING', 'VALIDATING'].includes(stage.stage)) {
      throw new TranscriptLeaseLostError('transcript_segment_stage_lost')
    }
    const cues = segmentTranscript(words)
    if (stage.stage !== 'VALIDATING') {
      const validating = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', stage: 'CUE_SEGMENTING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'VALIDATING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (validating.count !== 1) throw new TranscriptLeaseLostError('transcript_validation_fence_lost')
    }

    await options.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${run.mediaAssetId}, 0))`
      const runFence = await transaction.processingRun.updateMany({
        where: {
          id: run.id, mediaAssetId: run.mediaAssetId, status: 'PROCESSING', stage: 'VALIDATING',
          leaseOwner: options.workerId, leaseExpiresAt: { gt: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_publish_fence_lost')
      const currentChunks = await transaction.processingChunk.findMany({
        where: { processingRunId: run.id }, select: { status: true },
      })
      if (!currentChunks.length || currentChunks.some((chunk) => chunk.status !== 'SUCCEEDED')) {
        throw new TranscriptLeaseLostError('transcript_publish_fence_lost')
      }
      const last = await transaction.transcriptVersion.aggregate({ where: { mediaAssetId: run.mediaAssetId }, _max: { version: true } })
      const transcript = await transaction.transcriptVersion.create({
        data: {
          mediaAssetId: run.mediaAssetId, processingRunId: run.id,
          version: (last._max.version ?? 0) + 1, language: 'en', status: 'BUILDING',
          pipelineVersion: run.pipelineVersion, modelVersion,
          durationMs: run.mediaAsset.durationMs!, cueCount: cues.length,
          cues: { create: cues.map((cue) => ({
            order: cue.order, startMs: cue.startMs, endMs: cue.endMs, text: cue.text,
            words: cue.words as unknown as Prisma.InputJsonValue,
          })) },
        },
      })
      await transaction.transcriptVersion.updateMany({
        where: { mediaAssetId: run.mediaAssetId, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' },
      })
      await transaction.transcriptVersion.update({
        where: { id: transcript.id }, data: { status: 'ACTIVE', publishedAt: now() },
      })
      await transaction.privateLesson.upsert({
        where: { mediaAssetId: run.mediaAssetId },
        create: {
          ownerId: run.ownerId, mediaAssetId: run.mediaAssetId, transcriptVersionId: transcript.id,
          title: run.mediaAsset.title, status: 'PROCESSING',
        },
        update: { transcriptVersionId: transcript.id, title: run.mediaAsset.title },
      })
      const completed = await transaction.processingRun.updateMany({
        where: {
          id: run.id, mediaAssetId: run.mediaAssetId, status: 'PROCESSING', stage: 'VALIDATING',
          leaseOwner: options.workerId,
        },
        data: {
          status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY', completedAt: now(),
          leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorDetail: Prisma.DbNull,
        },
      })
      if (completed.count !== 1) throw new TranscriptLeaseLostError('transcript_publish_fence_lost')
    }, { maxWait: 10_000, timeout: 60_000 })
    return { completed: true, cueCount: cues.length, wordCount: words.length }
  }

  return async (job: TranscriptJob) => {
    const claimed = await options.database.processingRun.updateMany({
      where: {
        id: job.processingRunId, mediaAssetId: job.mediaAssetId, pipelineVersion: G3_PIPELINE_VERSION,
        status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] },
        OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now() } }],
      },
      data: { status: 'PROCESSING', leaseOwner: options.workerId, leaseExpiresAt: new Date(now().getTime() + 5 * 60_000), startedAt: now() },
    })
    if (claimed.count !== 1) return { skipped: true }
    const heartbeat = setInterval(() => void options.database.processingRun.updateMany({
      where: { id: job.processingRunId, status: 'PROCESSING', leaseOwner: options.workerId },
      data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    }).catch(() => undefined), 30_000)
    heartbeat.unref()
    const directory = await mkdtemp(join(tmpdir(), 'echoflow-transcript-'))
    try {
      const run = await options.database.processingRun.findUniqueOrThrow({
        where: { id: job.processingRunId },
        include: { mediaAsset: { include: { objects: { where: { kind: 'ORIGINAL', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 } } } },
      })
      if (['PLAYBACK_READY', 'AUDIO_EXTRACTING', 'CHUNKING'].includes(run.stage)) await prepareAudio(run, directory)
      const refreshed = await options.database.processingRun.findUniqueOrThrow({ where: { id: run.id } })
      if (refreshed.stage === 'TRANSCRIBING' && !await transcribe(run, directory)) return { skipped: false, waiting: true }
      return await publish(run, directory)
    } catch (error) {
      if (error instanceof TranscriptLeaseLostError) return { skipped: true, leaseLost: true }
      const current = await options.database.processingRun.findUnique({
        where: { id: job.processingRunId }, select: { attempt: true, stage: true },
      })
      const code = error instanceof TranscriptValidationError
        ? error.code
        : current && ['MERGING', 'CUE_SEGMENTING', 'VALIDATING'].includes(current.stage)
          ? 'transcript_publish_failed'
          : current?.stage === 'TRANSCRIBING'
            ? 'moss_unavailable'
            : 'audio_extract_failed'
      const attempt = (current?.attempt ?? 0) + 1
      const terminal = error instanceof TranscriptValidationError || attempt >= options.env.MOSS_MAX_ATTEMPTS
      await options.database.processingRun.updateMany({
        where: { id: job.processingRunId, status: 'PROCESSING', leaseOwner: options.workerId },
        data: terminal ? {
          status: 'FAILED', failedAt: now(), errorCode: code, errorDetail: { message: error instanceof Error ? error.message.slice(0, 500) : 'unknown' },
          leaseOwner: null, leaseExpiresAt: null, attempt,
        } : {
          status: 'QUEUED', stage: current?.stage ?? 'PLAYBACK_READY', errorCode: code, attempt,
          errorDetail: { message: error instanceof Error ? error.message.slice(0, 500) : 'unknown' }, leaseOwner: null, leaseExpiresAt: null,
        },
      })
      if (!terminal) throw error
      return { skipped: false, failed: true, errorCode: code }
    } finally {
      clearInterval(heartbeat)
      await rm(directory, { recursive: true, force: true })
    }
  }
}
