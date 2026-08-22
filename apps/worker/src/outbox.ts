import { randomUUID } from 'node:crypto'
import type { Queue } from 'bullmq'
import type { PrismaClient } from '@online-learning/database'
import type { PlaybackJob } from './processors/playback'
import type { TranscriptJob } from './processors/transcript'
import { G3_PIPELINE_VERSION } from './transcript/constants'

export type MediaQueueJob = PlaybackJob | TranscriptJob
type QueueWriter = Pick<Queue<MediaQueueJob>, 'add'>
type RevisionedChunk = { chunkIndex: number; planRevision: number }

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

export async function publishPendingOutbox(database: PrismaClient, queue: QueueWriter, mossEnabled = false) {
  const eventTypes = mossEnabled
    ? [
        'media.upload_verified', 'media.playback_ready', 'moss.callback_received',
        'media.transcript_retry_requested', 'media.transcript_cancel_requested',
      ]
    : ['media.upload_verified']
  const pending = await database.outboxEvent.findMany({
    where: { status: 'PENDING', eventType: { in: eventTypes }, availableAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' }, take: 100,
  })
  let published = 0
  for (const event of pending) {
    const payload = event.payload
    if (!isPayload(payload)) {
      await database.outboxEvent.update({
        where: { id: event.id }, data: { status: 'FAILED', lastError: 'invalid_media_queue_payload', attempts: { increment: 1 } },
      })
      continue
    }
    try {
      const jobName = event.eventType
      const jobId = jobName === 'media.upload_verified'
        ? `processing-${payload.processingRunId}-${payload.attempt ?? 0}`
        : jobName === 'moss.callback_received'
          ? `transcript-callback-${event.id}`
          : `transcript-start-${payload.processingRunId}`
      await queue.add(jobName, payload, { jobId, attempts: 1, removeOnComplete: 500, removeOnFail: 500 })
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
          lastError: error instanceof Error ? error.message.slice(0, 1_000) : 'queue_publish_failed',
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
      processingRuns: { none: { pipelineVersion: G3_PIPELINE_VERSION } },
    },
    select: { id: true, ownerId: true }, take: 100,
  })
  for (const asset of assets) {
    const runId = randomUUID()
    await database.$transaction(async (transaction) => {
      const run = await transaction.processingRun.upsert({
        where: { mediaAssetId_pipelineVersion: { mediaAssetId: asset.id, pipelineVersion: G3_PIPELINE_VERSION } },
        create: {
          id: runId, ownerId: asset.ownerId, mediaAssetId: asset.id,
          pipelineVersion: G3_PIPELINE_VERSION, stage: 'PLAYBACK_READY',
        },
        update: {},
      })
      await transaction.outboxEvent.upsert({
        where: { idempotencyKey: `media:${asset.id}:playback_ready:${G3_PIPELINE_VERSION}` },
        create: {
          aggregateType: 'MediaAsset', aggregateId: asset.id, eventType: 'media.playback_ready',
          idempotencyKey: `media:${asset.id}:playback_ready:${G3_PIPELINE_VERSION}`,
          payload: { mediaAssetId: asset.id, processingRunId: run.id },
        },
        update: {},
      })
    })
  }
  return { created: assets.length }
}

export async function enqueueRecoverableTranscriptRuns(database: PrismaClient, queue: QueueWriter) {
  const now = new Date()
  const recoverable = await database.processingRun.findMany({
    where: {
      pipelineVersion: G3_PIPELINE_VERSION,
      status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] },
      OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
    },
    select: { id: true, mediaAssetId: true }, take: 100,
  })
  const bucket = Math.floor(Date.now() / 5_000)
  for (const run of recoverable) {
    await queue.add('media.transcript_process', { mediaAssetId: run.mediaAssetId, processingRunId: run.id }, {
      jobId: `transcript-recover-${run.id}-${bucket}`, attempts: 1, removeOnComplete: 500, removeOnFail: 500,
    })
  }
  return { enqueued: recoverable.length }
}

export async function enqueuePendingTranscriptCancellations(database: PrismaClient, queue: QueueWriter) {
  const candidates = await database.processingRun.findMany({
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
  })
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
  return { enqueued: runs.length }
}
