import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_V2_ENROLL_DURATION_MS, MediaAssetStatus, PrismaClient, arbitrateTranscriptRun,
} from '../src/index'

const TEST_DB = 'echoflow_g2_v2_foundation_test'
const TEST_DATABASE_URL = `postgresql://online_learning:online_learning@localhost:5432/${TEST_DB}`

let prisma: PrismaClient

async function createAsset(durationMs = 100_000, overrides: { status?: MediaAssetStatus; deletedAt?: Date | null } = {}) {
  const userId = randomUUID()
  const assetId = randomUUID()
  await prisma.user.create({ data: { id: userId, phone: `139${Math.random().toString(16).slice(2, 8)}`, displayName: 'fixture' } })
  await prisma.mediaAsset.create({
    data: {
      id: assetId, ownerId: userId, status: overrides.status ?? 'PLAYABLE', title: 'arbiter-fixture',
      originalName: 'arbiter-fixture.mp4', durationMs, deletedAt: overrides.deletedAt ?? null,
    },
  })
  return { userId, assetId }
}

function v1Request(assetId: string) {
  return {
    mediaAssetId: assetId,
    pipelineVersion: 'g3-transcript-v1' as const,
    startStage: 'PLAYBACK_READY' as const,
    eventType: 'media.playback_ready',
    idempotencyKey: `media:${assetId}:playback_ready:g3-transcript-v1`,
  }
}

function v2Request(ownerId: string, assetId: string, extra: Record<string, unknown> = {}) {
  return {
    mediaAssetId: assetId,
    pipelineVersion: 'g3-transcript-v2' as const,
    startStage: 'HANDOFF_EVIDENCING' as const,
    eventType: 'media.transcript_process.v2',
    idempotencyKey: `media:${assetId}:enroll:g3-transcript-v2`,
    ownerId,
    requireNoActiveTranscript: true,
    maxDurationMs: MAX_V2_ENROLL_DURATION_MS,
    explicitEnrollment: true,
    queueCorrelationHandle: `g3-v2-enroll:${randomUUID().replaceAll('-', '')}`,
    ...extra,
  }
}

const arbitrate = (request: Parameters<typeof arbitrateTranscriptRun>[1]) =>
  prisma.$transaction((tx) => arbitrateTranscriptRun(tx, request))

describe('TranscriptRunArbiter — PostgreSQL integration', () => {
  beforeAll(async () => {
    // Disposable DB is created by the package pretest.
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } })
    await prisma.$connect()
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a v1 run + outbox event and is idempotent for the same pipeline', async () => {
    const { assetId } = await createAsset()
    const first = await arbitrate(v1Request(assetId))
    expect(first.kind).toBe('created')
    const runId = first.kind === 'created' ? first.processingRunId : null

    const second = await arbitrate(v1Request(assetId))
    expect(second.kind).toBe('idempotent')
    if (second.kind === 'idempotent') expect(second.processingRunId).toBe(runId)

    const run = await prisma.processingRun.findUnique({ where: { mediaAssetId_pipelineVersion: { mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v1' } } })
    expect(run).not.toBeNull()
    const outbox = await prisma.outboxEvent.findUnique({ where: { idempotencyKey: `media:${assetId}:playback_ready:g3-transcript-v1` } })
    expect(outbox).not.toBeNull()
    expect(outbox!.eventType).toBe('media.playback_ready')
  })

  it('rejects a v2 enrollment while a v1 run is active (mutual exclusion)', async () => {
    const { userId, assetId } = await createAsset()
    expect((await arbitrate(v1Request(assetId))).kind).toBe('created')
    const outcome = await arbitrate(v2Request(userId, assetId))
    expect(outcome).toEqual({ kind: 'conflict', reason: 'other_pipeline_holds_media' })
  })

  it('rejects v2 enrollment when the media has an ACTIVE transcript from another pipeline', async () => {
    const { userId, assetId } = await createAsset()
    const runId = randomUUID()
    await prisma.processingRun.create({
      data: { id: runId, ownerId: userId, mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v1', status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY' },
    })
    await prisma.transcriptVersion.create({
      data: { id: randomUUID(), mediaAssetId: assetId, processingRunId: runId, version: 1, status: 'ACTIVE', pipelineVersion: 'g3-transcript-v1', modelVersion: 'm', durationMs: 100_000 },
    })
    const guarded = await arbitrate(v2Request(userId, assetId))
    expect(guarded).toEqual({ kind: 'not_eligible', reason: 'active_transcript_exists' })
  })

  it('enrolls v2 for an eligible asset with no other pipeline holding it', async () => {
    const { userId, assetId } = await createAsset(100_000)
    const outcome = await arbitrate(v2Request(userId, assetId))
    expect(outcome.kind).toBe('created')
    const run = await prisma.processingRun.findUnique({
      where: { mediaAssetId_pipelineVersion: { mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v2' } },
    })
    expect(run).not.toBeNull()
    expect(run!.stage).toBe('HANDOFF_EVIDENCING')
  })

  it('rejects v2 enrollment on owner mismatch, non-playable, deleted and over-duration assets', async () => {
    const ownerMismatch = await createAsset()
    expect(await arbitrate(v2Request(randomUUID(), ownerMismatch.assetId))).toEqual({ kind: 'not_eligible', reason: 'owner_mismatch' })

    const nonPlayable = await createAsset(100_000, { status: 'PROCESSING_PLAYBACK' })
    expect(await arbitrate(v2Request(nonPlayable.userId, nonPlayable.assetId))).toEqual({ kind: 'not_eligible', reason: 'not_playable' })

    const deleted = await createAsset(100_000, { deletedAt: new Date() })
    expect(await arbitrate(v2Request(deleted.userId, deleted.assetId))).toEqual({ kind: 'not_eligible', reason: 'deleted' })

    const tooLong = await createAsset(MAX_V2_ENROLL_DURATION_MS + 1)
    expect(await arbitrate(v2Request(tooLong.userId, tooLong.assetId))).toEqual({ kind: 'not_eligible', reason: 'duration_exceeds_limit' })
  })

  it('rejects an internal v2 caller that omits any explicit-enrollment guard', async () => {
    const { assetId } = await createAsset()
    const outcome = await arbitrate({
      mediaAssetId: assetId,
      pipelineVersion: 'g3-transcript-v2',
      startStage: 'HANDOFF_EVIDENCING',
      eventType: 'media.transcript_process.v2',
      idempotencyKey: `media:${assetId}:unsafe-v2`,
    })
    expect(outcome).toEqual({ kind: 'not_eligible', reason: 'explicit_enrollment_required' })
    expect(await prisma.processingRun.count({ where: { mediaAssetId: assetId } })).toBe(0)
    expect(await prisma.outboxEvent.count({ where: { idempotencyKey: `media:${assetId}:unsafe-v2` } })).toBe(0)
  })

  it('makes same-key v2 enrollment idempotent but rejects a different key while active', async () => {
    const { userId, assetId } = await createAsset()
    const first = await arbitrate(v2Request(userId, assetId))
    expect(first.kind).toBe('created')
    const runId = first.kind === 'created' ? first.processingRunId : ''

    await expect(arbitrate(v2Request(userId, assetId))).resolves.toEqual({ kind: 'idempotent', processingRunId: runId })
    await expect(arbitrate(v2Request(userId, assetId, { idempotencyKey: `media:${assetId}:other-v2-key` }))).resolves.toEqual({
      kind: 'conflict', reason: 'other_pipeline_holds_media',
    })
    expect(await prisma.processingRun.count({ where: { mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v2' } })).toBe(1)
    expect(await prisma.outboxEvent.count({ where: { aggregateId: runId, eventType: 'media.transcript_process.v2' } })).toBe(1)
  })

  it('serializes concurrent same-key v2 enrollment under the media advisory lock', async () => {
    const { userId, assetId } = await createAsset()
    const outcomes = await Promise.all([
      arbitrate(v2Request(userId, assetId)),
      arbitrate(v2Request(userId, assetId)),
    ])
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['created', 'idempotent'])
    expect(await prisma.processingRun.count({ where: { mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v2' } })).toBe(1)
    expect(await prisma.outboxEvent.count({ where: { eventType: 'media.transcript_process.v2' } })).toBeGreaterThan(0)
  })

  it('permits v2 only after failed/cancelled v1 and never treats a succeeded-but-unpublished v1 as eligible', async () => {
    for (const status of ['FAILED', 'CANCELLED'] as const) {
      const { userId, assetId } = await createAsset()
      await prisma.processingRun.create({
        data: {
          ownerId: userId, mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v1',
          status, stage: 'PLAYBACK_READY',
        },
      })
      await expect(arbitrate(v2Request(userId, assetId))).resolves.toMatchObject({ kind: 'created' })
    }

    const succeeded = await createAsset()
    await prisma.processingRun.create({
      data: {
        ownerId: succeeded.userId, mediaAssetId: succeeded.assetId, pipelineVersion: 'g3-transcript-v1',
        status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY',
      },
    })
    await expect(arbitrate(v2Request(succeeded.userId, succeeded.assetId))).resolves.toEqual({
      kind: 'not_eligible', reason: 'prior_pipeline_not_failed_or_cancelled',
    })
  })

  it('keeps a terminal v2 run replayable only by its original opaque key', async () => {
    const { userId, assetId } = await createAsset()
    const first = await arbitrate(v2Request(userId, assetId))
    const runId = first.kind === 'created' ? first.processingRunId : ''
    await prisma.processingRun.update({ where: { id: runId }, data: { status: 'CANCELLED' } })

    await expect(arbitrate(v2Request(userId, assetId))).resolves.toEqual({ kind: 'idempotent', processingRunId: runId })
    await expect(arbitrate(v2Request(userId, assetId, { idempotencyKey: `media:${assetId}:terminal-other-key` }))).resolves.toEqual({
      kind: 'not_eligible', reason: 'v2_run_already_terminal',
    })
  })
})
