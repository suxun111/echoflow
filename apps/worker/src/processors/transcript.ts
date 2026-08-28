import { execFile } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerEnv } from '@online-learning/config'
import { MAX_UPLOAD_DURATION_MS } from '@online-learning/contracts'
import { Prisma, type PrismaClient } from '@online-learning/database'
import type { MultipartStorageProvider, StoredObject } from '@online-learning/storage'
import { MossError, type MossAdapter, type MossResult } from '../moss/adapter'
import { parseSilenceCenters, parseSilenceWindows, planAudioChunks, planBoundaryRepair } from '../transcript/chunks'
import { G3_PIPELINE_VERSION } from '../transcript/constants'
import { buildTranscript, TranscriptValidationError, type TranscriptRepairDiagnostic } from '../transcript/merge'
import {
  PIPELINE_VERSION_V2,
  ZERO_H_COUNTS,
  assertPublishable,
  buildAlignmentIdempotencyKey,
  createCorrelationHandle,
  resolveAlignmentHandoff,
  resolveStrictHandoff,
  validateHandoffPair,
  validateStrictSegment,
  type AlignmentAdapter,
  type ChunkIdentity,
  type EvidenceIdentityView,
  type ExpectedEvidenceIdentity,
  type HCounts,
  type HandoffChunkView,
  type MaterializedEvidence,
  type ProofDigestService,
  type StrictAssessmentInputProvider,
} from '../handoff'

const execFileAsync = promisify(execFile)
const noProxyEnvironment = {
  ...process.env,
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
}
const MAX_AUTOMATIC_PLAN_REVISIONS = 1

export type TranscriptJob = { mediaAssetId: string; processingRunId: string }

class TranscriptLeaseLostError extends Error {}
class TranscriptDurationUnsupportedError extends Error {}

type BoundaryRepairDecision =
  | 'created'
  | 'blocked_pending_revision'
  | 'blocked_revision_limit'
  | 'no_eligible_silence_boundary'
  | 'repair_precondition_unavailable'

type G3MergeFailureDiagnosticV1 = {
  schemaVersion: 1
  source: 'strict_segment_merge'
  errorCode: 'transcript_incomplete'
  evaluatedPlanRevision: number
  handoff: TranscriptRepairDiagnostic
  repair: {
    maximumAutomaticRevisions: number
    activePlanRevision: number
    pendingPlanRevision: number | null
    decision: Exclude<BoundaryRepairDecision, 'created'>
  }
}

class TranscriptMergeFailureError extends TranscriptValidationError {
  constructor(
    error: TranscriptValidationError,
    readonly mergeFailureDiagnostic: G3MergeFailureDiagnosticV1,
  ) {
    super(error.code, error.message, error.repairDiagnostic)
    this.name = 'TranscriptMergeFailureError'
  }
}

export function renewTranscriptRunLease(
  database: PrismaClient,
  job: TranscriptJob,
  workerId: string,
  now = new Date(),
) {
  return database.processingRun.updateMany({
    where: {
      id: job.processingRunId, mediaAssetId: job.mediaAssetId,
      status: 'PROCESSING', leaseOwner: workerId, leaseExpiresAt: { gt: now },
    },
    data: { leaseExpiresAt: new Date(now.getTime() + 5 * 60_000) },
  })
}

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
      // Cancellation is a v1 MOSS operation.  Do not let a misnamed v2 job
      // reach the real adapter even when it is already terminal.
      pipelineVersion: G3_PIPELINE_VERSION,
      status: { in: ['CANCELLED', 'FAILED'] },
    },
    select: { id: true, status: true, activePlanRevision: true, pendingPlanRevision: true },
  })
  if (!run) return { skipped: true, cancelled: 0 }
  const planRevision = run.pendingPlanRevision ?? run.activePlanRevision
  const candidates = await database.processingChunk.findMany({
    where: {
      processingRunId: run.id, planRevision: { lte: planRevision },
    },
    orderBy: [{ chunkIndex: 'asc' }, { planRevision: 'desc' }],
    select: {
      id: true, chunkIndex: true, planRevision: true, status: true, errorCode: true, externalCancelledAt: true,
      externalJobId: true, idempotencyKey: true, submittedAt: true,
    },
  })
  const currentChunks = effectivePlanChunks(candidates, planRevision).filter((chunk) => (
    chunk.externalCancelledAt === null
    && (run.status === 'CANCELLED'
      ? chunk.status === 'CANCELLED'
      : ['QUEUED', 'PROCESSING', 'VALIDATING'].includes(chunk.status)
        || (chunk.status === 'FAILED' && chunk.errorCode === 'moss_timeout'))
  ))
  let cancelled = 0
  for (const chunk of currentChunks) {
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

/**
 * Retired pre-F2 compatibility shape. It is intentionally private and has no
 * runtime source: F2 uses handoff/runtime.ts instead of this real-media
 * processor. Kept only while the surrounding v1 helper code is removed in a
 * future focused cleanup.
 */
type RetiredV2HandoffOptions = {
  alignment: AlignmentAdapter
  proof: ProofDigestService
  assessment: StrictAssessmentInputProvider
  /** Synthetic, non-content method/model/config digests for alignment jobs. */
  methodDigest: string
  modelDigest: string
  configDigest: string
}

type TranscriptProcessorOptions = {
  database: PrismaClient
  storage: MultipartStorageProvider
  moss: MossAdapter
  env: ServerEnv
  workerId: string
  now?: () => Date
}

/** F2 deliberately has no legacy transcript-processor handoff injection. */
function retiredV2Handoff(): RetiredV2HandoffOptions | undefined {
  return undefined
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

export function normalizedWavDurationMs(bytes: Buffer) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('normalized_audio_invalid_wav')
  }
  let offset = 12
  let sampleRate = 0
  let blockAlign = 0
  let dataLength: number | null = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const contentStart = offset + 8
    const contentEnd = contentStart + length
    if (contentEnd > bytes.length) throw new Error('normalized_audio_invalid_wav')
    if (id === 'fmt ') {
      if (length < 16) throw new Error('normalized_audio_invalid_wav')
      const format = bytes.readUInt16LE(contentStart)
      const channels = bytes.readUInt16LE(contentStart + 2)
      sampleRate = bytes.readUInt32LE(contentStart + 4)
      blockAlign = bytes.readUInt16LE(contentStart + 12)
      const bitsPerSample = bytes.readUInt16LE(contentStart + 14)
      if (format !== 1 || channels !== 1 || sampleRate !== 16_000 || blockAlign !== 2 || bitsPerSample !== 16) {
        throw new Error('normalized_audio_unexpected_format')
      }
    } else if (id === 'data') {
      dataLength = length
    }
    offset = contentEnd + (length % 2)
  }
  if (!sampleRate || !blockAlign || dataLength === null || dataLength <= 0 || dataLength % blockAlign !== 0) {
    throw new Error('normalized_audio_invalid_wav')
  }
  return Math.round((dataLength / blockAlign) * 1000 / sampleRate)
}

export function chunkPlanDurationMs(mediaDurationMs: number, normalizedAudioDurationMs: number) {
  if (!Number.isInteger(mediaDurationMs) || mediaDurationMs <= 0 || !Number.isInteger(normalizedAudioDurationMs) || normalizedAudioDurationMs <= 0) {
    throw new Error('normalized_audio_duration_invalid')
  }
  return Math.min(mediaDurationMs, normalizedAudioDurationMs)
}

function retryAt(now: Date, attempt: number) {
  const base = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(attempt, 8)))
  return new Date(now.getTime() + Math.round(base * (0.75 + Math.random() * 0.5)))
}

function recordMetadata(value: Prisma.JsonValue | null) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

type RevisionedChunk = { chunkIndex: number; planRevision: number }

function effectivePlanChunks<T extends RevisionedChunk>(chunks: readonly T[], revision: number): T[] {
  const selected = new Map<number, T>()
  for (const chunk of chunks) {
    if (chunk.planRevision > revision) continue
    const current = selected.get(chunk.chunkIndex)
    if (!current || chunk.planRevision > current.planRevision) selected.set(chunk.chunkIndex, chunk)
  }
  return [...selected.values()].sort((left, right) => left.chunkIndex - right.chunkIndex)
}

function mossIdempotencyKey(input: {
  pipelineVersion: string
  sourceVersion: string
  planRevision: number
  chunkIndex: number
  startMs: number
  endMs: number
  inputObjectKey: string
  inputVersionId: string
  inputChecksum: string
  modelVersion: string
}) {
  const identity = createHash('sha256').update([
    input.sourceVersion, input.pipelineVersion, input.planRevision, input.chunkIndex,
    input.startMs, input.endMs, input.inputObjectKey, input.inputVersionId,
    input.inputChecksum, input.modelVersion,
  ].join('|')).digest('hex')
  return `g3:${identity}`
}

export function createTranscriptProcessor(options: TranscriptProcessorOptions) {
  const now = options.now ?? (() => new Date())
  const leaseOwnerContext = new AsyncLocalStorage<string>()
  let storageReady: Promise<void> | null = null

  function leaseOwner() {
    const value = leaseOwnerContext.getStore()
    if (!value) throw new Error('transcript_lease_context_missing')
    return value
  }

  function ensureVersionedStorage() {
    storageReady ??= options.storage.ensureBucket()
      .then(() => options.storage.ensureVersioning())
      .finally(() => { storageReady = null })
    return storageReady
  }

  async function currentPlan(runId: string) {
    const run = await options.database.processingRun.findUniqueOrThrow({
      where: { id: runId },
      select: { activePlanRevision: true, pendingPlanRevision: true },
    })
    return {
      activePlanRevision: run.activePlanRevision,
      pendingPlanRevision: run.pendingPlanRevision,
      revision: run.pendingPlanRevision ?? run.activePlanRevision,
    }
  }

  async function currentPlanChunks(runId: string) {
    const plan = await currentPlan(runId)
    const chunks = await options.database.processingChunk.findMany({
      where: { processingRunId: runId, planRevision: { lte: plan.revision } },
      orderBy: [{ chunkIndex: 'asc' }, { planRevision: 'desc' }],
    })
    return { ...plan, chunks: effectivePlanChunks(chunks, plan.revision) }
  }

  async function assertLease(runId: string) {
    const run = await options.database.processingRun.findFirst({
      where: {
        id: runId, status: 'PROCESSING', leaseOwner: leaseOwner(),
        leaseExpiresAt: { gt: now() },
      },
      select: { id: true },
    })
    if (!run) throw new TranscriptLeaseLostError('transcript_lease_lost')
  }

  async function withRunFence<T>(runId: string, action: (transaction: Prisma.TransactionClient) => Promise<T>) {
    return options.database.$transaction(async (transaction) => {
      const runFence = await transaction.processingRun.updateMany({
        where: {
          id: runId, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return action(transaction)
    })
  }

  function isMissingObject(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error
      && ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(String((error as { code?: unknown }).code))
  }

  async function uploadTrackedObject(
    runId: string,
    mediaAssetId: string,
    kind: 'NORMALIZED_AUDIO' | 'AUDIO_CHUNK' | 'ASR_RAW',
    logicalObjectKey: string,
    filePath: string,
    contentType: string,
    checksumSha256: string,
    metadata: Record<string, Prisma.InputJsonValue>,
  ) {
    const expectedSize = (await stat(filePath)).size
    const logicalIdentity = `${options.storage.bucket}:${logicalObjectKey}`
    const sameLogicalIdentity = (candidate: { objectKey: string; metadata: Prisma.JsonValue | null }) => {
      const candidateMetadata = recordMetadata(candidate.metadata)
      return candidate.objectKey === logicalObjectKey || candidateMetadata.logicalObjectKey === logicalObjectKey
    }
    const exactVersion = (object: StoredObject) => {
      if (!object.versionId) throw new Error('object_store_version_required')
      return object.versionId
    }
    const activateInTransaction = async (
      transaction: Prisma.TransactionClient,
      recordId: string,
      object: StoredObject,
    ) => {
      const versionId = exactVersion(object)
      const current = await transaction.mediaObject.findUniqueOrThrow({ where: { id: recordId } })
      if (current.versionId && current.versionId !== versionId) throw new Error('tracked_object_version_conflict')
      let activeRecordId = current.id
      if (!(current.versionId === versionId && !current.purgedAt && recordMetadata(current.metadata).uploadState === 'READY')) {
        const adopted = await transaction.mediaObject.findFirst({
          where: {
            id: { not: current.id }, bucket: options.storage.bucket,
            objectKey: object.objectKey, versionId,
          },
          select: { id: true, metadata: true, purgedAt: true },
        })
        if (adopted) {
          if (!current.versionId) await transaction.mediaObject.delete({ where: { id: current.id } })
          if (adopted.purgedAt || recordMetadata(adopted.metadata).uploadState !== 'READY') {
            await transaction.mediaObject.update({
              where: { id: adopted.id },
              data: {
                contentType: object.contentType ?? contentType, sizeBytes: BigInt(object.sizeBytes),
                etag: object.etag, checksumSha256, metadata: {
                  ...metadata, logicalObjectKey, uploadState: 'READY', activatedBy: leaseOwner(),
                }, purgedAt: null,
              },
            })
          }
          activeRecordId = adopted.id
        } else {
          await transaction.mediaObject.update({
            where: { id: current.id },
            data: {
              versionId, contentType: object.contentType ?? contentType,
              sizeBytes: BigInt(object.sizeBytes), etag: object.etag, checksumSha256,
              metadata: { ...metadata, logicalObjectKey, uploadState: 'READY', activatedBy: leaseOwner() }, purgedAt: null,
            },
          })
        }
      }
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${logicalIdentity}, 0))`
      const fenced = await transaction.processingRun.updateMany({
        where: {
          id: runId, mediaAssetId, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (fenced.count !== 1) {
        const activeRecord = await transaction.mediaObject.findUniqueOrThrow({ where: { id: activeRecordId } })
        if (recordMetadata(activeRecord.metadata).activatedBy === leaseOwner()) {
          await transaction.mediaObject.update({
            where: { id: activeRecordId }, data: { deletedAt: activeRecord.deletedAt ?? now() },
          })
        }
        return false
      }
      const records = await transaction.mediaObject.findMany({
        where: { mediaAssetId, kind, bucket: options.storage.bucket, deletedAt: null },
        select: { id: true, objectKey: true, metadata: true },
      })
      const retiredIds = records
        .filter((candidate) => candidate.id !== activeRecordId && sameLogicalIdentity(candidate))
        .map((candidate) => candidate.id)
      if (retiredIds.length) {
        await transaction.mediaObject.updateMany({
          where: { id: { in: retiredIds }, deletedAt: null }, data: { deletedAt: now() },
        })
      }
      await transaction.mediaObject.update({
        where: { id: activeRecordId }, data: { createdAt: now(), deletedAt: null, purgedAt: null },
      })
      return true
    }

    const activate = async (recordId: string, object: StoredObject) => {
      const activated = await options.database.$transaction(async (transaction) => {
        const objectIdentity = `${options.storage.bucket}:${object.objectKey}`
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
        return activateInTransaction(transaction, recordId, object)
      }, { maxWait: 10_000, timeout: 30_000 })
      if (!activated) throw new TranscriptLeaseLostError('tracked_object_fence_lost')
      return object
    }

    const candidates = (await options.database.mediaObject.findMany({
      where: { mediaAssetId, kind, bucket: options.storage.bucket, deletedAt: null, purgedAt: null },
      orderBy: { createdAt: 'desc' },
    })).filter(sameLogicalIdentity)
    for (const candidate of candidates) {
      if (candidate.checksumSha256 !== checksumSha256 || Number(candidate.sizeBytes) !== expectedSize) continue
      try {
        const reused = await options.database.$transaction(async (transaction) => {
          const objectIdentity = `${options.storage.bucket}:${candidate.objectKey}`
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
          const current = await transaction.mediaObject.findFirst({
            where: { id: candidate.id, deletedAt: null, purgedAt: null },
          })
          if (!current) return null
          const existing = await options.storage.statObject(current.objectKey, current.versionId)
          exactVersion(existing)
          const verificationPath = `${filePath}.remote-${randomUUID()}`
          try {
            await options.storage.downloadFile(existing.objectKey, verificationPath, existing.versionId)
            if (await checksum(await readFile(verificationPath)) === checksumSha256) {
              return { object: existing, activated: await activateInTransaction(transaction, current.id, existing) }
            }
          } finally {
            await rm(verificationPath, { force: true })
          }
          const active = await transaction.processingRun.findFirst({
            where: {
              id: runId, mediaAssetId, status: 'PROCESSING', leaseOwner: leaseOwner(),
              leaseExpiresAt: { gt: now() },
            },
            select: { id: true },
          })
          if (!active) throw new TranscriptLeaseLostError('transcript_lease_lost')
          await transaction.mediaObject.updateMany({
            where: { id: current.id, deletedAt: null }, data: { deletedAt: now() },
          })
          return null
        }, { maxWait: 10 * 60_000, timeout: 30 * 60_000 })
        if (reused) {
          if (!reused.activated) throw new TranscriptLeaseLostError('tracked_object_fence_lost')
          return reused.object
        }
      } catch (error) {
        if (!isMissingObject(error)) throw error
      }
    }

    const separator = logicalObjectKey.lastIndexOf('/')
    const directory = separator >= 0 ? logicalObjectKey.slice(0, separator) : ''
    const filename = separator >= 0 ? logicalObjectKey.slice(separator + 1) : logicalObjectKey
    const attemptId = randomUUID()
    const objectKey = `${directory ? `${directory}/` : ''}attempts/${attemptId}/${filename}`
    const record = await options.database.$transaction(async (reservation) => {
      await reservation.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${logicalIdentity}, 0))`
      const active = await reservation.processingRun.findFirst({
        where: {
          id: runId, mediaAssetId, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        select: { id: true },
      })
      if (!active) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return reservation.mediaObject.create({
        data: {
          mediaAssetId, kind, bucket: options.storage.bucket, objectKey, versionId: null,
          contentType, sizeBytes: BigInt(expectedSize), checksumSha256,
          metadata: {
            ...metadata, logicalObjectKey, uploadAttemptId: attemptId,
            uploadAttemptOwner: leaseOwner(), uploadState: 'PENDING',
          },
        },
      })
    }, { maxWait: 10_000, timeout: 30_000 })

    const uploaded = await options.storage.uploadFile(objectKey, filePath, contentType)
    exactVersion(uploaded)
    if (uploaded.sizeBytes !== expectedSize) throw new Error('tracked_object_size_mismatch')
    return activate(record.id, uploaded)
  }

  async function prepareAudio(run: {
    id: string
    mediaAssetId: string
    pipelineVersion: string
    mediaAsset: {
      ownerId: string
      durationMs: number | null
      objects: Array<{ id: string; objectKey: string; versionId: string | null; etag: string | null }>
    }
  }, directory: string) {
    const mediaDurationMs = run.mediaAsset.durationMs
    const source = run.mediaAsset.objects[0]
    if (!mediaDurationMs || !source) throw new Error('media_object_missing')
    const existingChunks = await options.database.processingChunk.count({ where: { processingRunId: run.id, planRevision: 0 } })
    if (existingChunks > 0) {
      const resumed = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'TRANSCRIBING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (resumed.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return
    }

    const extracting = await options.database.processingRun.updateMany({
      where: {
        id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
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
    const normalizedBytes = await readFile(normalizedPath)
    const normalizedChecksum = await checksum(normalizedBytes)
    const normalizedAudioDurationMs = normalizedWavDurationMs(normalizedBytes)
    const planDurationMs = chunkPlanDurationMs(mediaDurationMs, normalizedAudioDurationMs)
    await uploadTrackedObject(run.id, run.mediaAssetId, 'NORMALIZED_AUDIO', normalizedKey, normalizedPath, 'audio/wav', normalizedChecksum, {
      processingRunId: run.id, sourceObjectId: source.id, normalizedAudioDurationMs, expiresAfter: 'terminal+24h',
    })

    const chunking = await options.database.processingRun.updateMany({
      where: {
        id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
        leaseExpiresAt: { gt: now() },
      },
      data: { stage: 'CHUNKING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    })
    if (chunking.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
    const silence = await runFfmpeg(options.env.FFMPEG_PATH, [
      '-hide_banner', '-i', normalizedPath, '-af', 'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-',
    ], 6 * 60 * 60_000).then((output) => parseSilenceCenters(output.stderr)).catch(() => [])
    const plan = planAudioChunks(
      planDurationMs,
      options.env.MOSS_CHUNK_TARGET_SECONDS * 1000,
      options.env.MOSS_CHUNK_OVERLAP_SECONDS * 1000,
      silence,
    )
    const uploaded: Array<{
      plan: (typeof plan)[number]
      object: { objectKey: string; versionId: string; checksum: string }
    }> = []
    for (const chunk of plan) {
      await assertLease(run.id)
      const staged = stagedObjects.find((object) => {
        if (object.kind !== 'AUDIO_CHUNK') return false
        const metadata = recordMetadata(object.metadata)
        return metadata.chunkIndex === chunk.chunkIndex && metadata.startMs === chunk.startMs && metadata.endMs === chunk.endMs
      })
      const chunkPath = join(directory, `plan-0-chunk-${String(chunk.chunkIndex).padStart(4, '0')}.wav`)
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
      const key = `owners/${run.mediaAsset.ownerId}/audio/${run.mediaAssetId}/${run.id}/plans/0/chunks/${String(chunk.chunkIndex).padStart(4, '0')}-${chunk.startMs}-${chunk.endMs}.wav`
      const chunkChecksum = await checksum(await readFile(chunkPath))
      const object = await uploadTrackedObject(run.id, run.mediaAssetId, 'AUDIO_CHUNK', key, chunkPath, 'audio/wav', chunkChecksum, {
        processingRunId: run.id, planRevision: 0, chunkIndex: chunk.chunkIndex, startMs: chunk.startMs,
        endMs: chunk.endMs, expiresAfter: 'terminal+24h',
      })
      if (!object.versionId) throw new Error('object_store_version_required')
      uploaded.push({
        plan: chunk, object: { objectKey: object.objectKey, versionId: object.versionId, checksum: chunkChecksum },
      })
    }
    const sourceVersion = source.versionId ?? source.etag ?? source.id
    await options.database.$transaction(async (transaction) => {
      const fenced = await transaction.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'TRANSCRIBING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (fenced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      for (const item of uploaded) {
        await transaction.processingChunk.create({
          data: {
            processingRunId: run.id, planRevision: 0, chunkIndex: item.plan.chunkIndex,
            startMs: item.plan.startMs, endMs: item.plan.endMs,
            idempotencyKey: mossIdempotencyKey({
              pipelineVersion: run.pipelineVersion, sourceVersion, planRevision: 0, chunkIndex: item.plan.chunkIndex,
              startMs: item.plan.startMs, endMs: item.plan.endMs,
              inputObjectKey: item.object.objectKey, inputVersionId: item.object.versionId,
              inputChecksum: item.object.checksum, modelVersion: options.env.MOSS_MODEL_VERSION,
            }),
            modelVersion: options.env.MOSS_MODEL_VERSION,
            inputObjectKey: item.object.objectKey, inputVersionId: item.object.versionId,
            inputChecksum: item.object.checksum,
          },
        })
      }
    }, { maxWait: 10_000, timeout: 60_000 })
  }

  async function completeChunk(run: { id: string; mediaAssetId: string; mediaAsset: { ownerId: string } }, chunk: {
    id: string; planRevision: number; chunkIndex: number; startMs: number; endMs: number
    externalJobId: string; idempotencyKey: string
  }, result: MossResult, directory: string) {
    const bytes = Buffer.from(JSON.stringify(result))
    const resultChecksum = await checksum(bytes)
    const path = join(directory, `plan-${chunk.planRevision}-result-${String(chunk.chunkIndex).padStart(4, '0')}.json`)
    await writeFile(path, bytes)
    const key = `owners/${run.mediaAsset.ownerId}/asr/${run.mediaAssetId}/${run.id}/plans/${chunk.planRevision}/chunks/${String(chunk.chunkIndex).padStart(4, '0')}.json`
    const object = await uploadTrackedObject(run.id, run.mediaAssetId, 'ASR_RAW', key, path, 'application/json', resultChecksum, {
      processingRunId: run.id, planRevision: chunk.planRevision, chunkIndex: chunk.chunkIndex, externalJobId: chunk.externalJobId,
      idempotencyKey: chunk.idempotencyKey, resultChecksum, immutable: true, expiresAfter: 'fetched+7d',
    })
    await options.database.$transaction(async (transaction) => {
      const runFence = await transaction.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      const fenced = await transaction.processingChunk.updateMany({
        where: {
          id: chunk.id, planRevision: chunk.planRevision, status: 'PROCESSING', externalJobId: chunk.externalJobId,
          leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() },
        },
        data: {
          status: 'SUCCEEDED', resultObjectKey: object.objectKey, resultVersionId: object.versionId,
          resultChecksum, wordCount: result.words?.length ?? 0, completedAt: now(), nextPollAt: null,
          leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorDetail: Prisma.DbNull,
        },
      })
      if (fenced.count !== 1) throw new TranscriptLeaseLostError('transcript_chunk_fence_lost')
    })
  }

  async function transcribe(run: {
    id: string; mediaAssetId: string; mediaAsset: { ownerId: string }
  }, directory: string) {
    let { revision: planRevision, chunks } = await currentPlanChunks(run.id)
    for (const chunk of chunks) {
      if (chunk.status === 'SUCCEEDED' || chunk.status === 'CANCELLED' || chunk.status === 'FAILED') continue
      const chunkLeaseExpiresAt = new Date(now().getTime() + 5 * 60_000)
      const claimed = await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
          where: {
            id: chunk.id, planRevision, status: { in: ['QUEUED', 'PROCESSING'] },
            OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now() } }],
          },
          data: { leaseOwner: leaseOwner(), leaseExpiresAt: chunkLeaseExpiresAt },
        }))
      if (claimed.count !== 1) continue
      const ownedChunk = await options.database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })
      try {
        if (!ownedChunk.externalJobId) {
          const submissionStartedAt = ownedChunk.submittedAt ?? now()
          if (!ownedChunk.submittedAt) {
            await options.database.$transaction(async (transaction) => {
              const runFence = await transaction.processingRun.updateMany({
                where: {
                  id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
                  leaseExpiresAt: { gt: now() },
                },
                data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
              })
              if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
              const marked = await transaction.processingChunk.updateMany({
                where: {
                  id: ownedChunk.id, status: 'QUEUED', externalJobId: null, submittedAt: null,
                  leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() },
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
          let persisted
          try {
            persisted = await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, status: 'QUEUED', externalJobId: null,
                leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() },
              },
              data: {
                status: 'PROCESSING', externalJobId: submitted.externalJobId, submittedAt: submissionStartedAt,
                nextPollAt: new Date(now().getTime() + options.env.MOSS_POLL_INTERVAL_SECONDS * 1000),
                leaseOwner: null, leaseExpiresAt: null,
              },
            }))
          } catch (error) {
            if (!(error instanceof TranscriptLeaseLostError)) throw error
            const reconciled = await options.database.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, status: { in: ['QUEUED', 'PROCESSING', 'CANCELLED'] },
                externalJobId: null, idempotencyKey: submitted.idempotencyKey,
              },
              data: { externalJobId: submitted.externalJobId, submittedAt: submissionStartedAt },
            })
            const latest = reconciled.count === 1
              ? await options.database.processingChunk.findUnique({
                  where: { id: ownedChunk.id }, select: { status: true, externalJobId: true },
                })
              : null
            if (latest?.status === 'CANCELLED' && latest.externalJobId === submitted.externalJobId) {
              try {
                await options.moss.cancel(submitted.externalJobId)
                await options.database.processingChunk.updateMany({
                  where: {
                    id: ownedChunk.id, status: 'CANCELLED', externalJobId: submitted.externalJobId,
                    externalCancelledAt: null,
                  },
                  data: { externalCancelledAt: now() },
                })
              } catch {
                // The persisted external id is recovered by the cancellation scanner.
              }
            } else if (reconciled.count !== 1) {
              try {
                await options.moss.cancel(submitted.externalJobId)
              } catch {
                // A stable provider identity is still recoverable by idempotency lookup.
              }
            }
            throw error
          }
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
          await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, leaseOwner: leaseOwner(),
                leaseExpiresAt: { gt: now() },
              },
              data: { leaseOwner: null, leaseExpiresAt: null },
            }))
          continue
        }
        if (ownedChunk.submittedAt && now().getTime() - ownedChunk.submittedAt.getTime() > options.env.MOSS_JOB_TIMEOUT_SECONDS * 1000) {
          const failed = await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, leaseOwner: leaseOwner(),
                leaseExpiresAt: { gt: now() },
              },
              data: {
                status: 'FAILED', errorCode: 'moss_timeout', failedAt: now(), nextPollAt: null,
                externalCancelledAt: null, leaseOwner: null, leaseExpiresAt: null,
              },
            }))
          if (failed.count !== 1) throw new TranscriptLeaseLostError('transcript_chunk_fence_lost')
          let cancelled = false
          try {
            await options.moss.cancel(ownedChunk.externalJobId)
            cancelled = true
          } catch {
            // Persist the external id and leave cancellation unconfirmed for the recovery scanner.
          }
          if (cancelled) {
            await options.database.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, status: 'FAILED', errorCode: 'moss_timeout',
                externalJobId: ownedChunk.externalJobId, externalCancelledAt: null,
              },
              data: { externalCancelledAt: now() },
            })
          }
          continue
        }
        const external = await options.moss.query(ownedChunk.externalJobId)
        if (external.status === 'queued' || external.status === 'processing') {
          await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, leaseOwner: leaseOwner(),
                leaseExpiresAt: { gt: now() },
              },
              data: {
                nextPollAt: new Date(now().getTime() + options.env.MOSS_POLL_INTERVAL_SECONDS * 1000),
                leaseOwner: null, leaseExpiresAt: null,
              },
            }))
          continue
        }
        if (external.status === 'failed' || external.status === 'cancelled') {
          await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
              where: {
                id: ownedChunk.id, leaseOwner: leaseOwner(),
                leaseExpiresAt: { gt: now() },
              },
              data: {
                status: 'FAILED', errorCode: external.errorCode ?? 'moss_rejected', failedAt: now(), nextPollAt: null,
                leaseOwner: null, leaseExpiresAt: null,
              },
            }))
          continue
        }
        await completeChunk(run, {
          id: ownedChunk.id, planRevision: ownedChunk.planRevision, chunkIndex: ownedChunk.chunkIndex,
          startMs: ownedChunk.startMs, endMs: ownedChunk.endMs,
          externalJobId: ownedChunk.externalJobId, idempotencyKey: ownedChunk.idempotencyKey,
        }, await options.moss.result(ownedChunk.externalJobId), directory)
      } catch (error) {
        if (error instanceof TranscriptLeaseLostError) throw error
        const attempt = ownedChunk.attempt + 1
        const normalized = error instanceof MossError ? error : new MossError('moss_unavailable', 'MOSS operation failed', true)
        const terminal = !normalized.retryable || attempt >= options.env.MOSS_MAX_ATTEMPTS
        await withRunFence(run.id, (transaction) => transaction.processingChunk.updateMany({
            where: {
              id: ownedChunk.id, status: { in: ['QUEUED', 'PROCESSING'] }, leaseOwner: leaseOwner(),
              leaseExpiresAt: { gt: now() },
            },
            data: {
              status: terminal ? 'FAILED' : ownedChunk.externalJobId ? 'PROCESSING' : 'QUEUED',
              attempt, errorCode: normalized.code, errorDetail: { retryable: normalized.retryable },
              failedAt: terminal ? now() : null, nextPollAt: terminal ? null : retryAt(now(), attempt),
              leaseOwner: null, leaseExpiresAt: null,
            },
          }))
      }
    }
    const afterTranscription = await currentPlanChunks(run.id)
    if (afterTranscription.revision !== planRevision) return false
    chunks = afterTranscription.chunks
    const failed = chunks.find((chunk) => chunk.status === 'FAILED' || chunk.status === 'CANCELLED')
    if (failed) {
      const failedRun = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
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
          id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { leaseOwner: null, leaseExpiresAt: null },
      })
      if (released.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return false
    }
    const advanced = await options.database.processingRun.updateMany({
      where: {
        id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(),
        leaseExpiresAt: { gt: now() },
      },
      data: { stage: 'MERGING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    })
    if (advanced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
    return true
  }

  async function attemptBoundaryRepair(
    run: {
      id: string
      mediaAssetId: string
      pipelineVersion: string
      mediaAsset: {
        ownerId: string
        durationMs: number | null
        objects: Array<{ id: string; objectKey: string; versionId: string | null; etag: string | null }>
      }
    },
    directory: string,
    diagnostic: TranscriptRepairDiagnostic,
  ): Promise<BoundaryRepairDecision> {
    const plan = await currentPlan(run.id)
    if (plan.pendingPlanRevision !== null) return 'blocked_pending_revision'
    if (plan.activePlanRevision >= MAX_AUTOMATIC_PLAN_REVISIONS) return 'blocked_revision_limit'
    if (!run.mediaAsset.durationMs) return 'repair_precondition_unavailable'
    const current = await currentPlanChunks(run.id)
    if (current.revision !== plan.activePlanRevision) return 'repair_precondition_unavailable'
    const previous = current.chunks.find((chunk) => chunk.chunkIndex === diagnostic.previousChunkIndex)
    const next = current.chunks.find((chunk) => chunk.chunkIndex === diagnostic.nextChunkIndex)
    if (!previous || !next || next.chunkIndex !== previous.chunkIndex + 1) return 'repair_precondition_unavailable'
    const modelVersions = new Set(current.chunks.map((chunk) => chunk.modelVersion))
    if (modelVersions.size !== 1) return 'repair_precondition_unavailable'
    const modelVersion = [...modelVersions][0]

    const normalized = await options.database.mediaObject.findFirst({
      where: {
        mediaAssetId: run.mediaAssetId, kind: 'NORMALIZED_AUDIO', deletedAt: null,
        metadata: { path: ['processingRunId'], equals: run.id },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!normalized?.checksumSha256) return 'repair_precondition_unavailable'
    const normalizedPath = join(directory, `repair-plan-${plan.activePlanRevision + 1}-normalized.wav`)
    let repairPlanDurationMs: number
    try {
      await options.storage.downloadFile(normalized.objectKey, normalizedPath, normalized.versionId)
      const normalizedBytes = await readFile(normalizedPath)
      if (await checksum(normalizedBytes) !== normalized.checksumSha256) return 'repair_precondition_unavailable'
      repairPlanDurationMs = chunkPlanDurationMs(run.mediaAsset.durationMs, normalizedWavDurationMs(normalizedBytes))
    } catch (error) {
      if (isMissingObject(error)) return 'repair_precondition_unavailable'
      throw error
    }

    const silenceWindows = await runFfmpeg(options.env.FFMPEG_PATH, [
      '-hide_banner', '-i', normalizedPath, '-af', 'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-',
    ], 6 * 60 * 60_000).then((output) => parseSilenceWindows(output.stderr)).catch(() => [])
    const repair = planBoundaryRepair(
      current.chunks.map((chunk) => ({ chunkIndex: chunk.chunkIndex, startMs: chunk.startMs, endMs: chunk.endMs })),
      diagnostic.previousChunkIndex,
      repairPlanDurationMs,
      options.env.MOSS_CHUNK_OVERLAP_SECONDS * 1000,
      silenceWindows,
    )
    if (!repair) return 'no_eligible_silence_boundary'
    const nextRevision = plan.activePlanRevision + 1
    const source = run.mediaAsset.objects[0]
    if (!source) return 'repair_precondition_unavailable'
    const sourceVersion = source.versionId ?? source.etag ?? source.id
    const uploaded: Array<{
      plan: (typeof repair.replacementChunks)[number]
      object: { objectKey: string; versionId: string; checksum: string }
    }> = []
    for (const replacement of repair.replacementChunks) {
      await assertLease(run.id)
      const chunkPath = join(directory, `repair-plan-${nextRevision}-chunk-${String(replacement.chunkIndex).padStart(4, '0')}.wav`)
      await runFfmpeg(options.env.FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(replacement.startMs / 1000),
        '-t', String((replacement.endMs - replacement.startMs) / 1000), '-i', normalizedPath,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', chunkPath,
      ], 2 * 60 * 60_000)
      const inputChecksum = await checksum(await readFile(chunkPath))
      const key = `owners/${run.mediaAsset.ownerId}/audio/${run.mediaAssetId}/${run.id}/plans/${nextRevision}/chunks/${String(replacement.chunkIndex).padStart(4, '0')}-${replacement.startMs}-${replacement.endMs}.wav`
      const object = await uploadTrackedObject(run.id, run.mediaAssetId, 'AUDIO_CHUNK', key, chunkPath, 'audio/wav', inputChecksum, {
        processingRunId: run.id, planRevision: nextRevision, chunkIndex: replacement.chunkIndex,
        startMs: replacement.startMs, endMs: replacement.endMs,
        repairReason: diagnostic.kind, expiresAfter: 'terminal+24h',
      })
      if (!object.versionId) throw new Error('object_store_version_required')
      uploaded.push({ plan: replacement, object: { objectKey: object.objectKey, versionId: object.versionId, checksum: inputChecksum } })
    }

    const activated = await options.database.$transaction(async (transaction) => {
      const fenced = await transaction.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', stage: 'MERGING', activePlanRevision: plan.activePlanRevision,
          pendingPlanRevision: null, leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() },
        },
        data: {
          pendingPlanRevision: nextRevision, stage: 'TRANSCRIBING',
          repairPlan: {
            reasonCode: diagnostic.kind, automaticRepairCount: nextRevision,
            previousChunkIndex: repair.previousChunkIndex, nextChunkIndex: repair.nextChunkIndex,
            originalBoundaryMs: repair.originalBoundaryMs, replacementBoundaryMs: repair.replacementBoundaryMs,
            planRevision: nextRevision,
          },
          leaseOwner: null, leaseExpiresAt: null,
        },
      })
      if (fenced.count !== 1) return false
      for (const item of uploaded) {
        await transaction.processingChunk.create({
          data: {
            processingRunId: run.id, planRevision: nextRevision, chunkIndex: item.plan.chunkIndex,
            startMs: item.plan.startMs, endMs: item.plan.endMs,
            idempotencyKey: mossIdempotencyKey({
              pipelineVersion: run.pipelineVersion, sourceVersion, planRevision: nextRevision, chunkIndex: item.plan.chunkIndex,
              startMs: item.plan.startMs, endMs: item.plan.endMs,
              inputObjectKey: item.object.objectKey, inputVersionId: item.object.versionId,
              inputChecksum: item.object.checksum, modelVersion,
            }),
            modelVersion,
            inputObjectKey: item.object.objectKey, inputVersionId: item.object.versionId,
            inputChecksum: item.object.checksum,
          },
        })
      }
      return true
    }, { maxWait: 10_000, timeout: 60_000 })
    if (!activated) throw new TranscriptLeaseLostError('transcript_repair_fence_lost')
    return 'created'
  }

  type EvidencingChunk = {
    id: string
    processingRunId: string
    planRevision: number
    chunkIndex: number
    status: string
    resultObjectKey: string | null
    resultVersionId: string | null
    resultChecksum: string | null
    startMs: number
    endMs: number
  }

  type NormalizedIdentity = { versionId: string | null; checksum: string | null }

  function toHandoffChunkView(chunk: EvidencingChunk): HandoffChunkView {
    return {
      id: chunk.id,
      processingRunId: chunk.processingRunId,
      planRevision: chunk.planRevision,
      chunkIndex: chunk.chunkIndex,
      status: chunk.status,
      resultObjectKey: chunk.resultObjectKey,
      resultVersionId: chunk.resultVersionId,
      resultChecksum: chunk.resultChecksum,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
    }
  }

  async function readNormalizedIdentity(run: { id: string; mediaAssetId: string }): Promise<NormalizedIdentity> {
    const normalized = await options.database.mediaObject.findFirst({
      where: {
        mediaAssetId: run.mediaAssetId, kind: 'NORMALIZED_AUDIO', deletedAt: null,
        metadata: { path: ['processingRunId'], equals: run.id },
      },
      orderBy: { createdAt: 'desc' },
      select: { versionId: true, checksumSha256: true },
    })
    return { versionId: normalized?.versionId ?? null, checksum: normalized?.checksumSha256 ?? null }
  }

  function buildExpectedIdentity(
    runId: string,
    handoff: { id: string; planRevision: number; logicalHandoffIndex: number },
    previous: EvidencingChunk,
    next: EvidencingChunk,
    normalized: NormalizedIdentity,
  ): ExpectedEvidenceIdentity {
    const windowStartMs = Math.min(previous.endMs, next.startMs)
    const windowEndMs = Math.max(previous.endMs, next.startMs) || windowStartMs + 1
    const legacyHandoff = retiredV2Handoff()
    const digest = (fallback: string) => legacyHandoff ? fallback : ''
    return {
      handoffId: handoff.id,
      processingRunId: runId,
      planRevision: handoff.planRevision,
      logicalHandoffIndex: handoff.logicalHandoffIndex,
      previousChunkId: previous.id,
      nextChunkId: next.id,
      previousAsrObjectKey: previous.resultObjectKey ?? '',
      previousAsrVersionId: previous.resultVersionId ?? null,
      previousAsrChecksum: previous.resultChecksum ?? null,
      nextAsrObjectKey: next.resultObjectKey ?? '',
      nextAsrVersionId: next.resultVersionId ?? null,
      nextAsrChecksum: next.resultChecksum ?? null,
      normalizedAudioVersionId: normalized.versionId,
      normalizedAudioChecksum: normalized.checksum,
      windowStartMs,
      windowEndMs,
      methodDigest: legacyHandoff?.methodDigest ?? digest('m'),
      modelDigest: legacyHandoff?.modelDigest ?? digest('m'),
      configDigest: legacyHandoff?.configDigest ?? digest('c'),
      alignmentPolicyDigest: null,
    }
  }

  async function upsertHandoff(
    runId: string,
    planRevision: number,
    handoffIndex: number,
    previous: EvidencingChunk,
    next: EvidencingChunk,
  ) {
    return options.database.processingHandoff.upsert({
      where: {
        processingRunId_planRevision_logicalHandoffIndex: {
          processingRunId: runId, planRevision, logicalHandoffIndex: handoffIndex,
        },
      },
      create: {
        processingRunId: runId, planRevision, logicalHandoffIndex: handoffIndex,
        previousChunkId: previous.id, nextChunkId: next.id, status: 'ASSESSING',
      },
      update: {},
    })
  }

  type HandoffAssessmentRecord = {
    decision: string
    decisionCode: string
    evidenceType: string
    inputChecksum: string
    windowStartMs: number
    windowEndMs: number
  }

  async function materializeEvidence(
    run: { id: string },
    record: { id: string },
    assessment: HandoffAssessmentRecord,
    evidence: MaterializedEvidence,
  ) {
    await options.database.$transaction(async (transaction) => {
      const fenced = await transaction.processingRun.updateMany({
        where: { id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() } },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (fenced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      await transaction.handoffAssessment.create({
        data: {
          handoffId: record.id,
          decision: assessment.decision,
          decisionCode: assessment.decisionCode,
          evidenceType: assessment.evidenceType,
          inputChecksum: assessment.inputChecksum,
          windowStartMs: assessment.windowStartMs,
          windowEndMs: assessment.windowEndMs,
        },
      })
      await transaction.handoffEvidence.create({
        data: {
          handoffId: record.id,
          planRevision: evidence.planRevision,
          logicalHandoffIndex: evidence.logicalHandoffIndex,
          decision: evidence.decision,
          decisionCode: evidence.decisionCode,
          evidenceType: evidence.evidenceType,
          schemaVersion: evidence.schemaVersion,
          pipelineVersion: evidence.pipelineVersion,
          previousChunkId: evidence.previousChunkId,
          nextChunkId: evidence.nextChunkId,
          normalizedAudioVersionId: evidence.normalizedAudioVersionId,
          normalizedAudioChecksum: evidence.normalizedAudioChecksum,
          previousAsrObjectKey: evidence.previousAsrObjectKey,
          previousAsrVersionId: evidence.previousAsrVersionId,
          previousAsrChecksum: evidence.previousAsrChecksum,
          nextAsrObjectKey: evidence.nextAsrObjectKey,
          nextAsrVersionId: evidence.nextAsrVersionId,
          nextAsrChecksum: evidence.nextAsrChecksum,
          rawObjectKey: evidence.rawObjectKey,
          rawVersionId: evidence.rawVersionId,
          rawChecksum: evidence.rawChecksum,
          methodProvider: evidence.methodProvider,
          methodVersion: evidence.methodVersion,
          modelRevision: evidence.modelRevision,
          alignmentPolicyDigest: evidence.alignmentPolicyDigest,
          windowStartMs: evidence.windowStartMs,
          windowEndMs: evidence.windowEndMs,
          candidateCount: evidence.candidateCount,
          anchorCount: evidence.anchorCount,
          coverageMs: evidence.coverageMs,
          proofKeyVersion: evidence.proofKeyVersion,
          proofDigest: evidence.proofDigest,
        },
      })
      await transaction.processingHandoff.updateMany({
        where: { id: record.id, status: { not: 'EVIDENCED' } },
        data: { status: 'EVIDENCED', completedAt: now(), errorCode: null },
      })
    }, { maxWait: 10_000, timeout: 30_000 })
  }

  async function failHandoff(run: { id: string }, record: { id: string }, decisionCode: string) {
    await options.database.$transaction(async (transaction) => {
      const fenced = await transaction.processingRun.updateMany({
        where: { id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() } },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (fenced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      await transaction.processingHandoff.updateMany({
        where: { id: record.id },
        data: { status: 'FAILED', failedAt: now(), errorCode: decisionCode },
      })
      await transaction.processingRun.updateMany({
        where: { id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner() },
        data: { status: 'FAILED', failedAt: now(), errorCode: 'transcript_incomplete', leaseOwner: null, leaseExpiresAt: null },
      })
    }, { maxWait: 10_000, timeout: 30_000 })
  }

  async function resolveAlignmentAt(
    run: { id: string },
    record: { id: string; planRevision: number; logicalHandoffIndex: number },
    expected: ExpectedEvidenceIdentity,
    assessment: HandoffAssessmentRecord,
  ): Promise<'accepted' | 'waiting' | 'failed'> {
    const handoff = retiredV2Handoff()!
    let job = await options.database.alignmentJob.findUnique({ where: { handoffId: record.id } })
    if (!job) {
      const idempotencyKey = buildAlignmentIdempotencyKey({
        processingRunId: run.id,
        planRevision: record.planRevision,
        logicalHandoffIndex: record.logicalHandoffIndex,
        previousChunkId: expected.previousChunkId,
        previousAsrObjectKey: expected.previousAsrObjectKey,
        previousAsrVersionId: expected.previousAsrVersionId,
        previousAsrChecksum: expected.previousAsrChecksum,
        nextChunkId: expected.nextChunkId,
        nextAsrObjectKey: expected.nextAsrObjectKey,
        nextAsrVersionId: expected.nextAsrVersionId,
        nextAsrChecksum: expected.nextAsrChecksum,
        normalizedAudioVersionId: expected.normalizedAudioVersionId,
        normalizedAudioChecksum: expected.normalizedAudioChecksum,
        windowStartMs: expected.windowStartMs,
        windowEndMs: expected.windowEndMs,
        methodDigest: expected.methodDigest,
        modelDigest: expected.modelDigest,
        configDigest: expected.configDigest,
      })
      const correlationHandle = createCorrelationHandle()
      try {
        const submission = await handoff.alignment.submit({
          idempotencyKey,
          correlationHandle,
          pipelineVersion: PIPELINE_VERSION_V2,
          windowStartMs: expected.windowStartMs,
          windowEndMs: expected.windowEndMs,
          methodDigest: expected.methodDigest,
          modelDigest: expected.modelDigest,
          configDigest: expected.configDigest,
        })
        job = await options.database.alignmentJob.create({
          data: {
            handoffId: record.id, idempotencyKey, correlationHandle,
            status: 'SUBMITTED', attempt: 1, externalJobId: submission.externalJobId,
            windowStartMs: expected.windowStartMs, windowEndMs: expected.windowEndMs,
            methodDigest: expected.methodDigest, modelDigest: expected.modelDigest, configDigest: expected.configDigest,
            submittedAt: now(),
          },
        })
      } catch (error) {
        job = await options.database.alignmentJob.findUnique({ where: { handoffId: record.id } })
        if (!job) throw error
      }
    }

    if (job.status === 'SUCCEEDED') {
      const existing = await options.database.handoffEvidence.findUnique({ where: { handoffId: record.id } })
      if (existing) return 'accepted'
    }
    if (!job.externalJobId) return 'waiting'

    const status = await handoff.alignment.query(job.externalJobId)
    if (status.state === 'PENDING' || status.state === 'RUNNING') {
      await options.database.alignmentJob.updateMany({
        where: { id: job.id, externalJobId: job.externalJobId },
        data: { status: 'POLLING', nextPollAt: new Date(now().getTime() + 1_000) },
      })
      return 'waiting'
    }
    if (status.state === 'FAILED' || status.state === 'CANCELLED') {
      await failHandoff(run, record, status.code ?? 'alignment_failed')
      return 'failed'
    }
    const result = await handoff.alignment.read(job.externalJobId)
    const resolution = resolveAlignmentHandoff({
      expected,
      result,
      proof: handoff.proof,
      methodProvider: 'retired_v2_route',
      methodVersion: 'disabled',
      modelRevision: null,
    })
    if (resolution.kind === 'accepted') {
      await options.database.alignmentJob.updateMany({
        where: { id: job.id },
        data: { status: 'SUCCEEDED', completedAt: now(), nextPollAt: null },
      })
      await materializeEvidence(run, record, assessment, resolution.evidence)
      return 'accepted'
    }
    await options.database.alignmentJob.updateMany({
      where: { id: job.id },
      data: { status: 'FAILED', failedAt: now(), errorCode: resolution.decisionCode },
    })
    await failHandoff(run, record, resolution.decisionCode)
    return 'failed'
  }

  async function resolveHandoffAt(
    run: { id: string },
    planRevision: number,
    handoffIndex: number,
    previous: EvidencingChunk,
    next: EvidencingChunk,
    normalized: NormalizedIdentity,
  ): Promise<'accepted' | 'waiting' | 'failed'> {
    const handoff = retiredV2Handoff()!
    validateHandoffPair(previous as ChunkIdentity, next as ChunkIdentity, planRevision)
    const record = await upsertHandoff(run.id, planRevision, handoffIndex, previous, next)
    if (record.status === 'EVIDENCED') return 'accepted'
    if (record.status === 'FAILED' || record.status === 'CANCELLED') return 'failed'

    const expected = buildExpectedIdentity(run.id, record, previous, next, normalized)
    const strictInput = handoff.assessment.build(toHandoffChunkView(previous), toHandoffChunkView(next), planRevision)
    const strict = validateStrictSegment(strictInput)
    const assessment: HandoffAssessmentRecord = {
      decision: strict.decision,
      decisionCode: strict.decisionCode,
      evidenceType: strict.evidenceType,
      inputChecksum: strictInput.inputChecksum,
      windowStartMs: strict.windowStartMs,
      windowEndMs: strict.windowEndMs,
    }
    const resolution = resolveStrictHandoff(expected, strict, handoff.proof)
    if (resolution.kind === 'accepted') {
      await materializeEvidence(run, record, assessment, resolution.evidence)
      return 'accepted'
    }
    if (resolution.kind === 'rejected') {
      await options.database.handoffAssessment.create({
        data: {
          handoffId: record.id,
          decision: assessment.decision,
          decisionCode: assessment.decisionCode,
          evidenceType: assessment.evidenceType,
          inputChecksum: assessment.inputChecksum,
          windowStartMs: assessment.windowStartMs,
          windowEndMs: assessment.windowEndMs,
        },
      })
      await failHandoff(run, record, resolution.decisionCode)
      return 'failed'
    }
    return resolveAlignmentAt(run, record, expected, assessment)
  }

  async function handoffEvidencing(
    run: { id: string; mediaAssetId: string; mediaAsset: { ownerId: string } },
  ): Promise<'completed' | 'waiting' | 'failed'> {
    // If an old caller ever reintroduces this call, it must fail before it can
    // touch v1 media/object paths or advance a v2 run.
    if (!retiredV2Handoff()) return 'failed'
    const plan = await currentPlanChunks(run.id)
    const chunks = plan.chunks as unknown as EvidencingChunk[]
    if (chunks.length <= 1) {
      const advanced = await withRunFence(run.id, (transaction) => transaction.processingRun.updateMany({
        where: { id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() } },
        data: { stage: 'MERGING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      }))
      if (advanced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return 'completed'
    }

    const normalized = await readNormalizedIdentity(run)
    let waiting = false
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const previous = chunks[i]!
      const next = chunks[i + 1]!
      const result = await resolveHandoffAt(run, plan.revision, i, previous, next, normalized)
      if (result === 'waiting') waiting = true
      if (result === 'failed') return 'failed'
    }
    if (waiting) {
      const released = await options.database.processingRun.updateMany({
        where: { id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() } },
        data: { leaseOwner: null, leaseExpiresAt: null },
      })
      if (released.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
      return 'waiting'
    }

    const advanced = await withRunFence(run.id, (transaction) => transaction.processingRun.updateMany({
      where: { id: run.id, status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() } },
      data: { stage: 'MERGING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
    }))
    if (advanced.count !== 1) throw new TranscriptLeaseLostError('transcript_lease_lost')
    return 'completed'
  }

  async function v2HandoffCounts(
    transaction: Prisma.TransactionClient,
    run: { id: string; mediaAssetId: string },
    planRevision: number,
  ): Promise<HCounts> {
    const normalizedRow = await transaction.mediaObject.findFirst({
      where: {
        mediaAssetId: run.mediaAssetId, kind: 'NORMALIZED_AUDIO', deletedAt: null,
        metadata: { path: ['processingRunId'], equals: run.id },
      },
      orderBy: { createdAt: 'desc' },
      select: { versionId: true, checksumSha256: true },
    })
    const normalized: NormalizedIdentity = { versionId: normalizedRow?.versionId ?? null, checksum: normalizedRow?.checksumSha256 ?? null }
    const chunks = await transaction.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: { lte: planRevision } },
      orderBy: [{ chunkIndex: 'asc' }, { planRevision: 'desc' }],
      select: {
        id: true, processingRunId: true, planRevision: true, chunkIndex: true, status: true,
        resultObjectKey: true, resultVersionId: true, resultChecksum: true, startMs: true, endMs: true,
      },
    })
    const effective = effectivePlanChunks(chunks, planRevision)
    const effectiveChunkCount = effective.length
    const handoffs = await transaction.processingHandoff.findMany({
      where: { processingRunId: run.id, planRevision },
      include: { finalEvidence: true },
      orderBy: { logicalHandoffIndex: 'asc' },
    })
    const handoffInputs = handoffs.map((handoff) => {
      const previous = effective.find((chunk) => chunk.id === handoff.previousChunkId)!
      const next = effective.find((chunk) => chunk.id === handoff.nextChunkId)!
      const expected = buildExpectedIdentity(run.id, handoff, previous, next, normalized)
      const evidence: EvidenceIdentityView | null = handoff.finalEvidence ? {
        planRevision: handoff.finalEvidence.planRevision,
        logicalHandoffIndex: handoff.finalEvidence.logicalHandoffIndex,
        decision: handoff.finalEvidence.decision as EvidenceIdentityView['decision'],
        decisionCode: handoff.finalEvidence.decisionCode,
        evidenceType: handoff.finalEvidence.evidenceType as EvidenceIdentityView['evidenceType'],
        previousChunkId: handoff.finalEvidence.previousChunkId,
        nextChunkId: handoff.finalEvidence.nextChunkId,
        previousAsrObjectKey: handoff.finalEvidence.previousAsrObjectKey,
        previousAsrVersionId: handoff.finalEvidence.previousAsrVersionId,
        previousAsrChecksum: handoff.finalEvidence.previousAsrChecksum,
        nextAsrObjectKey: handoff.finalEvidence.nextAsrObjectKey,
        nextAsrVersionId: handoff.finalEvidence.nextAsrVersionId,
        nextAsrChecksum: handoff.finalEvidence.nextAsrChecksum,
        normalizedAudioVersionId: handoff.finalEvidence.normalizedAudioVersionId,
        normalizedAudioChecksum: handoff.finalEvidence.normalizedAudioChecksum,
        windowStartMs: handoff.finalEvidence.windowStartMs,
        windowEndMs: handoff.finalEvidence.windowEndMs,
        methodProvider: handoff.finalEvidence.methodProvider,
        methodVersion: handoff.finalEvidence.methodVersion,
        modelRevision: handoff.finalEvidence.modelRevision,
        alignmentPolicyDigest: handoff.finalEvidence.alignmentPolicyDigest,
      } : null
      return {
        logicalHandoffIndex: handoff.logicalHandoffIndex,
        firstAcceptedRevision: (handoff.planRevision === 0 ? 0 : 1) as 0 | 1,
        expected,
        evidence,
      }
    })
    return assertPublishable({
      runCancelled: false,
      activePlanRevision: planRevision,
      effectiveChunkCount,
      handoffs: handoffInputs,
    })
  }

  async function publish(run: {
    id: string; ownerId: string; mediaAssetId: string; pipelineVersion: string
    mediaAsset: {
      ownerId: string; title: string; durationMs: number | null
      objects: Array<{ id: string; objectKey: string; versionId: string | null; etag: string | null }>
    }
  }, directory: string) {
    if (!run.mediaAsset.durationMs) throw new TranscriptValidationError('transcript_timing_invalid', 'media duration is unavailable')
    const plan = await currentPlanChunks(run.id)
    const chunks = plan.chunks
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
      const path = join(directory, `merge-plan-${plan.revision}-${String(chunk.chunkIndex).padStart(4, '0')}.json`)
      await options.storage.downloadFile(chunk.resultObjectKey, path, chunk.resultVersionId)
      const bytes = await readFile(path)
      if (await checksum(bytes) !== chunk.resultChecksum) throw new TranscriptValidationError('transcript_incomplete', 'ASR result checksum mismatch')
      results.push({ chunkIndex: chunk.chunkIndex, startMs: chunk.startMs, endMs: chunk.endMs, result: JSON.parse(bytes.toString('utf8')) as MossResult })
    }
    let transcriptResult: ReturnType<typeof buildTranscript>
    try {
      transcriptResult = buildTranscript(results, run.mediaAsset.durationMs)
    } catch (error) {
      if (error instanceof TranscriptValidationError && error.repairDiagnostic) {
        const repairDecision = await attemptBoundaryRepair(run, directory, error.repairDiagnostic)
        if (repairDecision === 'created') return { replanned: true }
        throw new TranscriptMergeFailureError(error, {
          schemaVersion: 1,
          source: 'strict_segment_merge',
          errorCode: 'transcript_incomplete',
          evaluatedPlanRevision: plan.revision,
          handoff: error.repairDiagnostic,
          repair: {
            maximumAutomaticRevisions: MAX_AUTOMATIC_PLAN_REVISIONS,
            activePlanRevision: plan.activePlanRevision,
            pendingPlanRevision: plan.pendingPlanRevision,
            decision: repairDecision,
          },
        })
      }
      throw error
    }
    const stage = await options.database.processingRun.findUniqueOrThrow({
      where: { id: run.id }, select: { stage: true },
    })
    if (stage.stage === 'MERGING') {
      const segmenting = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', stage: 'MERGING', leaseOwner: leaseOwner(),
          leaseExpiresAt: { gt: now() },
        },
        data: { stage: 'CUE_SEGMENTING', leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (segmenting.count !== 1) throw new TranscriptLeaseLostError('transcript_segment_fence_lost')
    } else if (!['CUE_SEGMENTING', 'VALIDATING'].includes(stage.stage)) {
      throw new TranscriptLeaseLostError('transcript_segment_stage_lost')
    }
    const cues = transcriptResult.cues
    if (stage.stage !== 'VALIDATING') {
      const validating = await options.database.processingRun.updateMany({
        where: {
          id: run.id, status: 'PROCESSING', stage: 'CUE_SEGMENTING', leaseOwner: leaseOwner(),
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
          leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() },
          activePlanRevision: plan.activePlanRevision,
          pendingPlanRevision: plan.pendingPlanRevision,
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      })
      if (runFence.count !== 1) throw new TranscriptLeaseLostError('transcript_publish_fence_lost')
      const currentChunks = effectivePlanChunks(await transaction.processingChunk.findMany({
        where: { processingRunId: run.id, planRevision: { lte: plan.revision } },
        orderBy: [{ chunkIndex: 'asc' }, { planRevision: 'desc' }],
        select: { chunkIndex: true, planRevision: true, status: true },
      }), plan.revision)
      if (!currentChunks.length || currentChunks.some((chunk) => chunk.status !== 'SUCCEEDED')) {
        throw new TranscriptLeaseLostError('transcript_publish_fence_lost')
      }
      const last = await transaction.transcriptVersion.aggregate({ where: { mediaAssetId: run.mediaAssetId }, _max: { version: true } })
      const hCounts = run.pipelineVersion === PIPELINE_VERSION_V2
        ? await v2HandoffCounts(transaction, run, plan.revision)
        : ZERO_H_COUNTS
      const transcript = await transaction.transcriptVersion.create({
        data: {
          mediaAssetId: run.mediaAssetId, processingRunId: run.id,
          version: (last._max.version ?? 0) + 1, language: 'en', status: 'BUILDING',
          pipelineVersion: run.pipelineVersion, modelVersion, planRevision: plan.revision,
          durationMs: run.mediaAsset.durationMs!, cueCount: cues.length,
          hTotal: hCounts.hTotal, hUnique: hCounts.hUnique, hR1: hCounts.hR1,
          hUnresolved: hCounts.hUnresolved, hSegment: hCounts.hSegment,
          hProviderWord: hCounts.hProviderWord, hAlignment: hCounts.hAlignment,
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
          leaseOwner: leaseOwner(),
        },
        data: {
          status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY', completedAt: now(),
          activePlanRevision: plan.revision, pendingPlanRevision: null,
          leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorDetail: Prisma.DbNull,
        },
      })
      if (completed.count !== 1) throw new TranscriptLeaseLostError('transcript_publish_fence_lost')
    }, { maxWait: 10_000, timeout: 60_000 })
    return { completed: true, cueCount: cues.length, wordCount: transcriptResult.wordCount }
  }

  return async (job: TranscriptJob) => leaseOwnerContext.run(
    `${options.workerId}:${randomUUID()}`,
    async () => {
    // No caller may reach real storage, FFmpeg or MOSS for a v2 run while F2
    // is explicitly scoped to a test-only Fake state machine.
    const target = await options.database.processingRun.findFirst({
      where: { id: job.processingRunId, mediaAssetId: job.mediaAssetId },
      select: { pipelineVersion: true },
    })
    if (!target) return { skipped: true }
    if (target.pipelineVersion === PIPELINE_VERSION_V2) {
      return { skipped: true, reason: 'v2_fake_runtime_only' }
    }
    await ensureVersionedStorage()
    const claimed = await options.database.processingRun.updateMany({
      where: {
        id: job.processingRunId, mediaAssetId: job.mediaAssetId,
        pipelineVersion: G3_PIPELINE_VERSION,
        status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] },
        OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now() } }],
      },
      data: { status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: new Date(now().getTime() + 5 * 60_000), startedAt: now() },
    })
    if (claimed.count !== 1) return { skipped: true }
    const heartbeat = setInterval(() => void renewTranscriptRunLease(
      options.database, job, leaseOwner(), now(),
    ).catch(() => undefined), 30_000)
    heartbeat.unref()
    const directory = await mkdtemp(join(tmpdir(), 'echoflow-transcript-'))
    try {
      const run = await options.database.processingRun.findUniqueOrThrow({
        where: { id: job.processingRunId },
        include: { mediaAsset: { include: { objects: { where: { kind: 'ORIGINAL', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 } } } },
      })
      if (run.mediaAsset.durationMs === null || run.mediaAsset.durationMs > MAX_UPLOAD_DURATION_MS) {
        throw new TranscriptDurationUnsupportedError('media_duration_unsupported')
      }
      if (['PLAYBACK_READY', 'AUDIO_EXTRACTING', 'CHUNKING'].includes(run.stage)) await prepareAudio(run, directory)
      const refreshed = await options.database.processingRun.findUniqueOrThrow({ where: { id: run.id } })
      if (refreshed.stage === 'TRANSCRIBING' && !await transcribe(run, directory)) return { skipped: false, waiting: true }
      const published = await publish(run, directory)
      return 'replanned' in published ? { skipped: false, waiting: true, replanned: true } : published
    } catch (error) {
      if (error instanceof TranscriptLeaseLostError) return { skipped: true, leaseLost: true }
      const current = await options.database.processingRun.findUnique({
        where: { id: job.processingRunId }, select: { attempt: true, stage: true, leaseExpiresAt: true },
      })
      const code = error instanceof TranscriptDurationUnsupportedError
        ? 'media_duration_unsupported'
        : error instanceof TranscriptValidationError
          ? error.code
          : current && ['MERGING', 'CUE_SEGMENTING', 'VALIDATING'].includes(current.stage)
            ? 'transcript_publish_failed'
            : current?.stage === 'TRANSCRIBING'
              ? 'moss_unavailable'
              : 'audio_extract_failed'
      const attempt = (current?.attempt ?? 0) + 1
      const terminal = error instanceof TranscriptDurationUnsupportedError
        || error instanceof TranscriptValidationError
        || attempt >= options.env.MOSS_MAX_ATTEMPTS
      const errorDetail = error instanceof TranscriptMergeFailureError
        ? { g3MergeFailureDiagnostic: error.mergeFailureDiagnostic }
        : { message: error instanceof Error ? error.message.slice(0, 500) : 'unknown' }
      if (!current?.leaseExpiresAt || current.leaseExpiresAt.getTime() <= now().getTime()) {
        return { skipped: true, leaseLost: true }
      }
      await options.database.processingRun.updateMany({
        where: {
          id: job.processingRunId, mediaAssetId: job.mediaAssetId,
          status: 'PROCESSING', leaseOwner: leaseOwner(), leaseExpiresAt: { gt: now() },
        },
        data: terminal ? {
          status: 'FAILED', failedAt: now(), errorCode: code, errorDetail,
          leaseOwner: null, leaseExpiresAt: null, attempt,
        } : {
          status: 'QUEUED', stage: current?.stage ?? 'PLAYBACK_READY', errorCode: code, attempt,
          errorDetail, leaseOwner: null, leaseExpiresAt: null,
        },
      })
      if (!terminal) throw error
      return { skipped: false, failed: true, errorCode: code }
    } finally {
      clearInterval(heartbeat)
      await rm(directory, { recursive: true, force: true })
    }
  })
}
