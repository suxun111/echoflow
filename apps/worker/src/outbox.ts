import type { Queue } from 'bullmq'
import { arbitrateTranscriptRun, G3_PIPELINE_VERSION_V2, type Prisma, type PrismaClient } from '@online-learning/database'
import type { PlaybackJob } from './processors/playback'
import type { TranscriptJob } from './processors/transcript'
import { G3_PIPELINE_VERSION } from './transcript/constants'

export type V2FakeQueueJob = { v2JobHandle: string }
export type MediaQueueJob = PlaybackJob | TranscriptJob | V2FakeQueueJob
type QueueWriter = Pick<Queue<MediaQueueJob>, 'add'>
type RevisionedChunk = { chunkIndex: number; planRevision: number }

const G3_TRANSCRIPT_PIPELINES = [G3_PIPELINE_VERSION, G3_PIPELINE_VERSION_V2] as const

function effectivePlanChunks<T extends RevisionedChunk>(chunks: readonly T[], revision: number): T[] {
  const selected = new Map<number, T>()
  for (const chunk of chunks) {
    if (chunk.planRevision > revision) continue
    const current = selected.get(chunk.chunkIndex)
    if (!current || chunk.planRevision > current.planRevision) selected.set(chunk.chunkIndex, chunk)
  }
  return [...selected.values()]
}

function isPayload(value: unknown): value is TranscriptJob & { attempt?: number } {
  return typeof value === 'object' && value !== null
    && typeof (value as { mediaAssetId?: unknown }).mediaAssetId === 'string'
    && typeof (value as { processingRunId?: unknown }).processingRunId === 'string'
}

function isV2FakePayload(value: unknown): value is V2FakeQueueJob {
  return typeof value === 'object' && value !== null
    && typeof (value as { v2JobHandle?: unknown }).v2JobHandle === 'string'
    && /^[A-Za-z0-9._:-]{8,128}$/.test((value as { v2JobHandle: string }).v2JobHandle)
}

export async function publishPendingOutbox(
  database: PrismaClient,
  queue: QueueWriter,
  mossEnabled = false,
  v2FakeRuntimeEnabled = false,
) {
  // A Fake v2 worker owns a separate queue and must not wake a legacy
  // playback job even if the test database contains historical v1 events.
  const eventTypes = v2FakeRuntimeEnabled ? [] : ['media.upload_verified']
  if (mossEnabled) {
    eventTypes.push(
      'media.playback_ready', 'moss.callback_received',
      'media.transcript_retry_requested', 'media.transcript_cancel_requested',
    )
  }
  if (v2FakeRuntimeEnabled) {
    eventTypes.push('media.transcript_process.v2', 'media.transcript_cancel_requested.v2')
  }
  const pending = await database.outboxEvent.findMany({
    where: { status: 'PENDING', eventType: { in: eventTypes }, availableAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' }, take: 100,
  })
  let published = 0
  for (const event of pending) {
    // Defense in depth for a malformed/mock database response: v2 can reach
    // the queue only in the explicit test-only Fake runtime.
    if (!v2FakeRuntimeEnabled && (event.eventType === 'media.transcript_process.v2' || event.eventType === 'media.transcript_cancel_requested.v2')) continue
    const payload = event.payload
    const isV2Event = event.eventType === 'media.transcript_process.v2' || event.eventType === 'media.transcript_cancel_requested.v2'
    if (isV2Event ? !isV2FakePayload(payload) : !isPayload(payload)) {
      await database.outboxEvent.update({
        where: { id: event.id }, data: { status: 'FAILED', lastError: 'invalid_media_queue_payload', attempts: { increment: 1 } },
      })
      continue
    }
    try {
      const jobName = event.eventType
      if (isV2Event) {
        const v2Payload = payload as V2FakeQueueJob
        const jobId = jobName === 'media.transcript_process.v2'
          ? `transcript-v2-${v2Payload.v2JobHandle}`
          : `transcript-v2-cancel-${v2Payload.v2JobHandle}`
        await queue.add(jobName, v2Payload, { jobId, attempts: 1, removeOnComplete: 500, removeOnFail: 500 })
      } else {
        const legacyPayload = payload as TranscriptJob & { attempt?: number }
        const jobId = jobName === 'media.upload_verified'
          ? `processing-${legacyPayload.processingRunId}-${legacyPayload.attempt ?? 0}`
          : jobName === 'moss.callback_received'
            ? `transcript-callback-${event.id}`
            : `transcript-start-${legacyPayload.processingRunId}`
        await queue.add(jobName, legacyPayload, { jobId, attempts: 1, removeOnComplete: 500, removeOnFail: 500 })
      }
      const changed = await database.outboxEvent.updateMany({
        where: { id: event.id, status: 'PENDING' },
        data: { status: 'PUBLISHED', publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
      })
      published += changed.count
    } catch (error) {
      await database.outboxEvent.updateMany({
        where: { id: event.id, status: 'PENDING' },
        data: {
          attempts: { increment: 1 },
          // v2 Outbox is an audit boundary. Never persist an adapter/queue
          // message there because it may contain an opaque handle or provider
          // identity. Legacy v1 keeps its existing diagnostic behaviour.
          lastError: isV2Event
            ? 'queue_publish_failed'
            : error instanceof Error ? error.message.slice(0, 1_000) : 'queue_publish_failed',
          availableAt: new Date(Date.now() + 2_000),
        },
      })
    }
  }
  return { scanned: pending.length, published }
}

export async function enqueueRecoverableRuns(database: PrismaClient, queue: QueueWriter) {
  const recoverable = await database.processingRun.findMany({
    where: {
      pipelineVersion: 'g2-playback-v1',
      OR: [
        { status: 'QUEUED', stage: 'UPLOAD_VERIFIED' },
        { status: 'PROCESSING', stage: 'PROBING', leaseExpiresAt: { lt: new Date() } },
      ],
    },
    select: { id: true, mediaAssetId: true, attempt: true }, take: 100,
  })
  for (const run of recoverable) {
    await queue.add('media.upload_verified', { mediaAssetId: run.mediaAssetId, processingRunId: run.id }, {
      jobId: `processing-${run.id}-${run.attempt}`, attempts: 1, removeOnComplete: 500, removeOnFail: 500,
    })
  }
  return { enqueued: recoverable.length }
}

export async function ensureTranscriptRuns(database: PrismaClient) {
  const assets = await database.mediaAsset.findMany({
    where: {
      status: 'PLAYABLE', deletedAt: null,
      // A v2 enrollment must also suppress the legacy v1 auto-enrollment.
      // Otherwise a terminal v2 run would silently recreate v1 on the next
      // scheduler pass and defeat cross-pipeline isolation.
      processingRuns: { none: { pipelineVersion: { in: [...G3_TRANSCRIPT_PIPELINES] } } },
    },
    select: { id: true, ownerId: true }, take: 100,
  })
  let created = 0
  for (const asset of assets) {
    await database.$transaction(async (transaction) => {
      const outcome = await arbitrateTranscriptRun(transaction, {
        mediaAssetId: asset.id,
        pipelineVersion: G3_PIPELINE_VERSION,
        startStage: 'PLAYBACK_READY',
        eventType: 'media.playback_ready',
        idempotencyKey: `media:${asset.id}:playback_ready:${G3_PIPELINE_VERSION}`,
      })
      if (outcome.kind === 'created') created += 1
    })
  }
  return { created }
}

export async function enqueueRecoverableTranscriptRuns(
  database: PrismaClient,
  queue: QueueWriter,
  mossEnabled = true,
  v2FakeRuntimeEnabled = false,
) {
  const now = new Date()
  const recoverableWhere: Prisma.ProcessingRunWhereInput[] = []
  if (mossEnabled) {
    recoverableWhere.push({
      pipelineVersion: G3_PIPELINE_VERSION,
      status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] },
      OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
    })
  }
  if (v2FakeRuntimeEnabled) {
    recoverableWhere.push({
      pipelineVersion: G3_PIPELINE_VERSION_V2,
      stage: 'HANDOFF_EVIDENCING',
      status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] },
      OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
    })
  }
  if (recoverableWhere.length === 0) return { enqueued: 0 }
  const recoverable = await database.processingRun.findMany({
    where: {
      OR: recoverableWhere,
    },
    select: { id: true, mediaAssetId: true, pipelineVersion: true, requestId: true }, take: 100,
  })
  const bucket = Math.floor(Date.now() / 5_000)
  let enqueued = 0
  for (const run of recoverable) {
    if (run.pipelineVersion !== G3_PIPELINE_VERSION && (!v2FakeRuntimeEnabled || run.pipelineVersion !== G3_PIPELINE_VERSION_V2)) continue
    const isV2 = run.pipelineVersion === G3_PIPELINE_VERSION_V2
    if (isV2 && !isV2FakePayload({ v2JobHandle: run.requestId ?? '' })) continue
    const payload: MediaQueueJob = isV2
      ? { v2JobHandle: run.requestId! }
      : { mediaAssetId: run.mediaAssetId, processingRunId: run.id }
    await queue.add(isV2 ? 'media.transcript_process.v2' : 'media.transcript_process', payload, {
      jobId: isV2 ? `transcript-v2-recover-${run.requestId!}-${bucket}` : `transcript-recover-${run.id}-${bucket}`,
      attempts: 1, removeOnComplete: 500, removeOnFail: 500,
    })
    enqueued += 1
  }
  return { enqueued }
}

export async function enqueuePendingTranscriptCancellations(
  database: PrismaClient,
  queue: QueueWriter,
  mossEnabled = true,
  v2FakeRuntimeEnabled = false,
) {
  const candidates = mossEnabled ? await database.processingRun.findMany({
    where: {
      pipelineVersion: G3_PIPELINE_VERSION,
      OR: [
        { status: 'CANCELLED', chunks: { some: { status: 'CANCELLED', externalCancelledAt: null } } },
        {
          status: 'FAILED',
          chunks: { some: {
            externalCancelledAt: null,
            OR: [
              { status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] } },
              { status: 'FAILED', errorCode: 'moss_timeout' },
            ],
          } },
        },
      ],
    }, take: 100,
    select: {
      id: true, mediaAssetId: true, status: true, activePlanRevision: true, pendingPlanRevision: true,
      chunks: { select: { chunkIndex: true, planRevision: true, status: true, errorCode: true, externalCancelledAt: true } },
    },
  }) : []
  const runs = candidates.filter((run) => {
    const revision = run.pendingPlanRevision ?? run.activePlanRevision
    const chunks = effectivePlanChunks(run.chunks, revision)
    return run.status === 'CANCELLED'
      ? chunks.some((chunk) => chunk.status === 'CANCELLED' && chunk.externalCancelledAt === null)
      : chunks.some((chunk) => (
        (['QUEUED', 'PROCESSING', 'VALIDATING'].includes(chunk.status)
          || (chunk.status === 'FAILED' && chunk.errorCode === 'moss_timeout'))
        && chunk.externalCancelledAt === null
      ))
  }).slice(0, 100)
  const bucket = Math.floor(Date.now() / 5_000)
  for (const run of runs) {
    await queue.add('media.transcript_cancel_requested', { mediaAssetId: run.mediaAssetId, processingRunId: run.id }, {
      jobId: `transcript-cancel-${run.id}-${bucket}`, attempts: 1, removeOnComplete: 500, removeOnFail: 500,
    })
  }
  let v2Enqueued = 0
  if (v2FakeRuntimeEnabled) {
    const v2Runs = await database.processingRun.findMany({
      where: {
        pipelineVersion: G3_PIPELINE_VERSION_V2,
        status: 'CANCELLED',
        handoffs: {
          some: {
            alignmentJob: {
              is: {
                status: 'CANCELLED', externalJobId: { not: null }, externalCancelledAt: null,
              },
            },
          },
        },
      },
      select: { id: true, mediaAssetId: true, requestId: true },
      take: 100,
    })
    for (const run of v2Runs) {
      if (!isV2FakePayload({ v2JobHandle: run.requestId ?? '' })) continue
      await queue.add('media.transcript_cancel_requested.v2', {
        v2JobHandle: run.requestId!,
      }, {
        jobId: `transcript-v2-cancel-recover-${run.requestId!}-${bucket}`,
        attempts: 1, removeOnComplete: 500, removeOnFail: 500,
      })
      v2Enqueued += 1
    }
  }
  return { enqueued: runs.length + v2Enqueued }
}
