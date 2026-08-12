import type { Queue } from 'bullmq'
import type { PrismaClient } from '@online-learning/database'
import type { PlaybackJob } from './processors/playback'

export async function publishPendingOutbox(database: PrismaClient, queue: Queue<PlaybackJob>) {
  const pending = await database.outboxEvent.findMany({
    where: { status: 'PENDING', eventType: 'media.upload_verified', availableAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' }, take: 100,
  })
  let published = 0
  for (const event of pending) {
    const payload = event.payload as PlaybackJob
    if (!payload.mediaAssetId || !payload.processingRunId) {
      await database.outboxEvent.update({
        where: { id: event.id }, data: { status: 'FAILED', lastError: 'invalid_media_upload_verified_payload', attempts: { increment: 1 } },
      })
      continue
    }
    try {
      await queue.add('media.upload_verified', payload, {
        jobId: `processing-${payload.processingRunId}-${payload.attempt ?? 0}`,
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      })
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

export async function enqueueRecoverableRuns(database: PrismaClient, queue: Queue<PlaybackJob>) {
  const recoverable = await database.processingRun.findMany({
    where: {
      OR: [
        { status: 'QUEUED', stage: 'UPLOAD_VERIFIED' },
        { status: 'PROCESSING', stage: 'PROBING', leaseExpiresAt: { lt: new Date() } },
      ],
    },
    select: { id: true, mediaAssetId: true, attempt: true },
    take: 100,
  })
  for (const run of recoverable) {
    await queue.add('media.upload_verified', { mediaAssetId: run.mediaAssetId, processingRunId: run.id }, {
      jobId: `processing-${run.id}-${run.attempt}`,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 500,
    })
  }
  return { enqueued: recoverable.length }
}
