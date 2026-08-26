import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaAssetStatus, PrismaClient, arbitrateTranscriptRun } from '../src/index'

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

function v2Request(assetId: string, extra: Record<string, unknown> = {}) {
  return {
    mediaAssetId: assetId,
    pipelineVersion: 'g3-transcript-v2' as const,
    startStage: 'PLAYBACK_READY' as const,
    eventType: 'media.transcript_process.v2',
    idempotencyKey: `media:${assetId}:enroll:g3-transcript-v2`,
    requireNoActiveTranscript: true,
    maxDurationMs: 3_600_000,
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
    const { assetId } = await createAsset()
    expect((await arbitrate(v1Request(assetId))).kind).toBe('created')
    const outcome = await arbitrate(v2Request(assetId))
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
    const outcome = await arbitrate(v2Request(assetId, { requireNoActiveTranscript: false }))
    expect(outcome).toEqual({ kind: 'conflict', reason: 'other_pipeline_holds_media' })
    const guarded = await arbitrate(v2Request(assetId))
    expect(guarded).toEqual({ kind: 'not_eligible', reason: 'active_transcript_exists' })
  })

  it('enrolls v2 for an eligible asset with no other pipeline holding it', async () => {
    const { assetId } = await createAsset(100_000)
    const outcome = await arbitrate(v2Request(assetId))
    expect(outcome.kind).toBe('created')
    const run = await prisma.processingRun.findUnique({
      where: { mediaAssetId_pipelineVersion: { mediaAssetId: assetId, pipelineVersion: 'g3-transcript-v2' } },
    })
    expect(run).not.toBeNull()
    expect(run!.stage).toBe('PLAYBACK_READY')
  })

  it('rejects v2 enrollment on owner mismatch, non-playable, deleted and over-duration assets', async () => {
    const ownerMismatch = await createAsset()
    expect((await arbitrate(v2Request(ownerMismatch.assetId, { ownerId: randomUUID() }))).kind).toBe('not_eligible')

    const nonPlayable = await createAsset(100_000, { status: 'PROCESSING_PLAYBACK' })
    expect((await arbitrate(v2Request(nonPlayable.assetId))).kind).toBe('not_eligible')

    const deleted = await createAsset(100_000, { deletedAt: new Date() })
    expect((await arbitrate(v2Request(deleted.assetId))).kind).toBe('not_eligible')

    const tooLong = await createAsset(3_600_001)
    expect((await arbitrate(v2Request(tooLong.assetId))).kind).toBe('not_eligible')
  })
})
