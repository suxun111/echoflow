import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
) {
  const run = await database.processingRun.findFirst({
    where: { id: job.processingRunId, mediaAssetId: job.mediaAssetId, status: 'CANCELLED' },
    select: { id: true },
  })
  if (!run) return { skipped: true, cancelled: 0 }
  const chunks = await database.processingChunk.findMany({
    where: { processingRunId: run.id, externalJobId: { not: null }, externalCancelledAt: null },
    select: { id: true, externalJobId: true },
  })
  let cancelled = 0
  for (const chunk of chunks) {
    await moss.cancel(chunk.externalJobId!)
    const changed = await database.processingChunk.updateMany({
      where: { id: chunk.id, externalJobId: chunk.externalJobId, externalCancelledAt: null },
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
    await assertLease(runId)
    const expectedSize = (await stat(filePath)).size
    let record = await options.database.mediaObject.findFirst({
      where: { mediaAssetId, bucket: options.storage.bucket, objectKey, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (!record) {
      record = await options.database.mediaObject.create({
        data: {
          mediaAssetId, kind, bucket: options.storage.bucket, objectKey, versionId: null,
          contentType, sizeBytes: BigInt(expectedSize), checksumSha256,
          metadata: { ...metadata, uploadState: 'PENDING' },
        },
      })
    } else if (record.kind !== kind || record.checksumSha256 !== checksumSha256) {
      throw new Error('tracked_object_identity_conflict')
    }

    let object: StoredObject | null = null
    try {
      const existing = await options.storage.statObject(objectKey, record.versionId)
      if (existing.sizeBytes !== expectedSize) throw new Error('tracked_object_size_mismatch')
      object = existing
    } catch (error) {
      if (!isMissingObject(error)) throw error
    }
    if (!object) {
      await assertLease(runId)
      object = await options.storage.uploadFile(objectKey, filePath, contentType)
    }
    await assertLease(runId)
    const finalized = await options.database.mediaObject.updateMany({
      where: { id: record.id, deletedAt: null, checksumSha256 },
      data: {
        versionId: object.versionId, contentType: object.contentType ?? contentType,
        sizeBytes: BigInt(object.sizeBytes), etag: object.etag,
        metadata: { ...metadata, uploadState: 'READY' },
      },
    })
    if (finalized.count !== 1) throw new TranscriptLeaseLostError('tracked_object_fence_lost')
    return object
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
      await options.database.processingRun.updateMany({
        where: { id: run.id, leaseOwner: options.workerId }, data: { stage: 'TRANSCRIBING' },
      })
      return
    }

    await options.database.processingRun.updateMany({
      where: { id: run.id, leaseOwner: options.workerId }, data: { stage: 'AUDIO_EXTRACTING' },
    })
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
    let stagedNormalizedMissing = false
    if (stagedNormalized?.checksumSha256) {
      try {
        await options.storage.downloadFile(stagedNormalized.objectKey, normalizedPath, stagedNormalized.versionId)
        normalizedReady = await checksum(await readFile(normalizedPath)) === stagedNormalized.checksumSha256
      } catch (error) {
        if (!isMissingObject(error)) throw error
        stagedNormalizedMissing = true
        await options.database.mediaObject.update({
          where: { id: stagedNormalized.id }, data: { deletedAt: now(), purgedAt: now() },
        })
      }
      if (!normalizedReady && !stagedNormalizedMissing) {
        await options.storage.remove(stagedNormalized.objectKey, stagedNormalized.versionId)
        await options.database.mediaObject.update({
          where: { id: stagedNormalized.id }, data: { deletedAt: now(), purgedAt: now() },
        })
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

    await options.database.processingRun.updateMany({
      where: { id: run.id, leaseOwner: options.workerId }, data: { stage: 'CHUNKING' },
    })
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
      if (staged) {
        let existing: StoredObject | null = null
        try {
          existing = await options.storage.statObject(staged.objectKey, staged.versionId)
        } catch (error) {
          if (!isMissingObject(error)) throw error
          await options.database.mediaObject.update({ where: { id: staged.id }, data: { deletedAt: now(), purgedAt: now() } })
        }
        if (existing) {
          await options.database.mediaObject.update({
            where: { id: staged.id },
            data: {
              versionId: existing.versionId, sizeBytes: BigInt(existing.sizeBytes), etag: existing.etag,
              metadata: { ...recordMetadata(staged.metadata), uploadState: 'READY' },
            },
          })
          uploaded.push({ plan: chunk, object: { objectKey: staged.objectKey, versionId: existing.versionId } })
          continue
        }
      }
      const chunkPath = join(directory, `chunk-${String(chunk.chunkIndex).padStart(4, '0')}.wav`)
      await runFfmpeg(options.env.FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(chunk.startMs / 1000),
        '-t', String((chunk.endMs - chunk.startMs) / 1000), '-i', normalizedPath,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', chunkPath,
      ], 2 * 60 * 60_000)
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
        where: { id: run.id, status: 'PROCESSING', leaseOwner: options.workerId }, data: { stage: 'TRANSCRIBING' },
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
      const currentRun = await transaction.processingRun.findFirst({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: options.workerId,
          leaseExpiresAt: { gt: now() },
        },
        select: { id: true },
      })
      if (!currentRun) throw new TranscriptLeaseLostError('transcript_lease_lost')
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
              status: 'PROCESSING', externalJobId: submitted.externalJobId, submittedAt: now(),
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
                    status: 'PROCESSING', externalJobId: submitted.externalJobId, submittedAt: now(),
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
            where: { id: ownedChunk.id, leaseOwner: options.workerId }, data: { leaseOwner: null, leaseExpiresAt: null },
          })
          continue
        }
        if (ownedChunk.submittedAt && now().getTime() - ownedChunk.submittedAt.getTime() > options.env.MOSS_JOB_TIMEOUT_SECONDS * 1000) {
          await options.moss.cancel(ownedChunk.externalJobId).catch(() => undefined)
          await options.database.processingChunk.updateMany({
            where: { id: ownedChunk.id, leaseOwner: options.workerId }, data: {
              status: 'FAILED', errorCode: 'moss_timeout', failedAt: now(), nextPollAt: null,
              externalCancelledAt: now(), leaseOwner: null, leaseExpiresAt: null,
            },
          })
          continue
        }
        const external = await options.moss.query(ownedChunk.externalJobId)
        if (external.status === 'queued' || external.status === 'processing') {
          await options.database.processingChunk.updateMany({
            where: { id: ownedChunk.id, leaseOwner: options.workerId }, data: {
              nextPollAt: new Date(now().getTime() + options.env.MOSS_POLL_INTERVAL_SECONDS * 1000),
              leaseOwner: null, leaseExpiresAt: null,
            },
          })
          continue
        }
        if (external.status === 'failed' || external.status === 'cancelled') {
          await options.database.processingChunk.updateMany({
            where: { id: ownedChunk.id, leaseOwner: options.workerId }, data: {
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
      await options.database.processingRun.updateMany({
        where: { id: run.id, leaseOwner: options.workerId },
        data: {
          status: 'FAILED', failedAt: now(), errorCode: failed.errorCode ?? 'transcript_incomplete',
          errorDetail: { failedChunkIndex: failed.chunkIndex }, leaseOwner: null, leaseExpiresAt: null,
        },
      })
      return false
    }
    if (!chunks.length || chunks.some((chunk) => chunk.status !== 'SUCCEEDED')) {
      await options.database.processingRun.updateMany({
        where: { id: run.id, leaseOwner: options.workerId }, data: { leaseOwner: null, leaseExpiresAt: null },
      })
      return false
    }
    const advanced = await options.database.processingRun.updateMany({
      where: { id: run.id, leaseOwner: options.workerId }, data: { stage: 'MERGING' },
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
    const cues = segmentTranscript(words)
    await options.database.processingRun.updateMany({ where: { id: run.id, leaseOwner: options.workerId }, data: { stage: 'VALIDATING' } })

    await options.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${run.mediaAssetId}, 0))`
      const current = await transaction.processingRun.findFirst({
        where: { id: run.id, status: 'PROCESSING', leaseOwner: options.workerId },
        include: { chunks: { select: { status: true } } },
      })
      if (!current || !current.chunks.length || current.chunks.some((chunk) => chunk.status !== 'SUCCEEDED')) {
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
      await transaction.processingRun.update({
        where: { id: run.id }, data: {
          status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY', completedAt: now(),
          leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorDetail: Prisma.DbNull,
        },
      })
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
