/**
 * PostgreSQL-only coverage for the F2 test-only v2 queue route.
 *
 * This file deliberately uses a tiny in-memory QueueWriter. It never starts
 * Redis, MOSS, MinIO, FFmpeg, a media processor, or an external adapter.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@online-learning/database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueRecoverableTranscriptRuns,
  publishPendingOutbox,
} from './outbox'

const database = new PrismaClient({
  datasources: {
    db: {
      url: process.env.ECHOFLOW_G3_V2_RUNTIME_TEST_DATABASE_URL
        ?? 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test',
    },
  },
})

async function createV2Run() {
  const user = await database.user.create({
    data: { phone: `+86139${randomUUID().replaceAll('-', '').slice(0, 8)}`, displayName: 'F2 outbox fixture' },
  })
  const asset = await database.mediaAsset.create({
    data: {
      ownerId: user.id, title: 'F2 queue fixture', originalName: 'synthetic.mp4',
      status: 'PLAYABLE', durationMs: 60_000,
    },
  })
  const run = await database.processingRun.create({
    data: {
      ownerId: user.id, mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v2',
      stage: 'HANDOFF_EVIDENCING', status: 'QUEUED',
      requestId: `g3-v2-enroll:synthetic-outbox-${randomUUID().replaceAll('-', '')}`,
    },
  })
  return { asset, run }
}

async function cleanDatabase() {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
      "SubtitleCue", "TranscriptVersion", "OutboxEvent", "MossCallbackReceipt", "ProcessingChunk", "ProcessingRun",
      "HandoffEvidence", "AlignmentJob", "HandoffAssessment", "ProcessingHandoff",
      "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession", "OtpChallenge", "User"
    CASCADE
  `)
}

describe('F2 v2 Outbox and recovery route', () => {
  beforeAll(async () => database.$connect())
  beforeEach(cleanDatabase)
  afterAll(async () => database.$disconnect())

  it('publishes canonical v2 events only when the explicit Fake runtime gate is enabled', async () => {
    const { asset, run } = await createV2Run()
    const event = await database.outboxEvent.create({
      data: {
        aggregateType: 'ProcessingRun', aggregateId: run.id,
        eventType: 'media.transcript_process.v2', idempotencyKey: `f2-v2-process:${run.id}`,
        payload: { v2JobHandle: run.requestId },
      },
    })
    const add = vi.fn(async () => undefined)

    await expect(publishPendingOutbox(database, { add } as never, false, false)).resolves.toEqual({ scanned: 0, published: 0 })
    expect(add).not.toHaveBeenCalled()
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'PENDING' })

    await expect(publishPendingOutbox(database, { add } as never, false, true)).resolves.toEqual({ scanned: 1, published: 1 })
    expect(add).toHaveBeenCalledWith(
      'media.transcript_process.v2',
      { v2JobHandle: run.requestId },
      expect.objectContaining({ jobId: `transcript-v2-${run.requestId}`, attempts: 1 }),
    )
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'PUBLISHED', attempts: 1 })
  })

  it('routes v2 cancellation through its own Fake-only event name', async () => {
    const { asset, run } = await createV2Run()
    const event = await database.outboxEvent.create({
      data: {
        aggregateType: 'ProcessingRun', aggregateId: run.id,
        eventType: 'media.transcript_cancel_requested.v2', idempotencyKey: `f2-v2-cancel:${run.id}`,
        payload: { v2JobHandle: run.requestId },
      },
    })
    const add = vi.fn(async () => undefined)

    await expect(publishPendingOutbox(database, { add } as never, false, true)).resolves.toEqual({ scanned: 1, published: 1 })
    expect(add).toHaveBeenCalledWith(
      'media.transcript_cancel_requested.v2',
      { v2JobHandle: run.requestId },
      expect.objectContaining({ jobId: `transcript-v2-cancel-${run.requestId}`, attempts: 1 }),
    )
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'PUBLISHED' })
  })

  it('recovers only a v2 HANDOFF_EVIDENCING run under the Fake gate', async () => {
    const { asset, run } = await createV2Run()
    const add = vi.fn(async () => undefined)

    await expect(enqueueRecoverableTranscriptRuns(database, { add } as never, false, false)).resolves.toEqual({ enqueued: 0 })
    expect(add).not.toHaveBeenCalled()

    await expect(enqueueRecoverableTranscriptRuns(database, { add } as never, false, true)).resolves.toEqual({ enqueued: 1 })
    expect(add).toHaveBeenCalledWith(
      'media.transcript_process.v2',
      { v2JobHandle: run.requestId },
      expect.objectContaining({ jobId: expect.stringMatching(new RegExp(`^transcript-v2-recover-${run.requestId}-`)), attempts: 1 }),
    )
  })

  it('does not publish legacy events or persist a raw queue error in the v2 Fake route', async () => {
    const { asset, run } = await createV2Run()
    const legacy = await database.outboxEvent.create({
      data: {
        aggregateType: 'MediaAsset', aggregateId: asset.id,
        eventType: 'media.upload_verified', idempotencyKey: `f2-legacy-isolation:${run.id}`,
        payload: { mediaAssetId: asset.id, processingRunId: run.id },
      },
    })
    const v2 = await database.outboxEvent.create({
      data: {
        aggregateType: 'ProcessingRun', aggregateId: run.id,
        eventType: 'media.transcript_process.v2', idempotencyKey: `f2-v2-error:${run.id}`,
        payload: { v2JobHandle: run.requestId },
      },
    })
    const add = vi.fn(async () => { throw new Error(`sensitive queue failure ${run.requestId}`) })

    await expect(publishPendingOutbox(database, { add } as never, false, true)).resolves.toEqual({ scanned: 1, published: 0 })
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ status: 'PENDING', attempts: 0 })
    const failedV2 = await database.outboxEvent.findUniqueOrThrow({ where: { id: v2.id } })
    expect(failedV2).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'queue_publish_failed' })
    // The opaque handle is intentionally the queue payload; the persisted
    // diagnostic must nevertheless be a stable code rather than the raw
    // adapter error (which deliberately contains that handle in this test).
    expect(failedV2.lastError).not.toContain(run.requestId!)
  })
})
