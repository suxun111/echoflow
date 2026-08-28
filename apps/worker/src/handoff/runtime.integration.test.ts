/**
 * PostgreSQL-only integration coverage for the isolated F2 handoff runtime.
 *
 * The fixture contains no object identity or content digest. It never creates
 * media files, starts MinIO/Redis/MOSS/FFmpeg, or performs object-store or
 * network I/O.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@online-learning/database'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryAlignmentAdapter } from './alignment'
import { FakeStrictAssessmentInputProvider } from './evidencing'
import { FakeProofDigestService } from './proof'
import {
  advanceV2HandoffEvidencing,
  cancelV2HandoffEvidencing,
  type V2HandoffRuntimeOptions,
} from './runtime'

const database = new PrismaClient({
  datasources: {
    db: {
      url: process.env.ECHOFLOW_G3_V2_RUNTIME_TEST_DATABASE_URL
        ?? 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test',
    },
  },
})
const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')
const fixedNow = () => new Date('2026-08-27T00:00:00.000Z')

function makeRuntime(
  assessment: FakeStrictAssessmentInputProvider,
  alignment: InMemoryAlignmentAdapter,
  now: () => Date = fixedNow,
): V2HandoffRuntimeOptions {
  return {
    database,
    assessment,
    alignment,
    proof: new FakeProofDigestService(Buffer.from('f2-runtime-test-key'), 'f2-test-v1'),
    methodDigest: hex64('f2-method'),
    modelDigest: hex64('f2-model'),
    configDigest: hex64('f2-config'),
    workerId: 'f2-runtime-test-worker',
    now,
  }
}

async function createTwoChunkRun() {
  const identifier = randomUUID().replaceAll('-', '').slice(0, 12)
  const user = await database.user.create({
    data: { phone: `+86138${identifier.slice(0, 8)}`, displayName: 'F2 runtime fixture' },
  })
  const asset = await database.mediaAsset.create({
    data: {
      ownerId: user.id,
      title: 'Opaque F2 fixture',
      originalName: 'opaque-fixture.mp4',
      status: 'PLAYABLE',
      durationMs: 80_000,
    },
  })
  const run = await database.processingRun.create({
    data: {
      ownerId: user.id,
      mediaAssetId: asset.id,
      pipelineVersion: 'g3-transcript-v2',
      stage: 'HANDOFF_EVIDENCING',
    },
  })
  await database.processingChunk.createMany({
    data: [
      {
        processingRunId: run.id,
        planRevision: 0,
        chunkIndex: 0,
        startMs: 0,
        endMs: 42_000,
        status: 'SUCCEEDED',
        idempotencyKey: `f2-runtime:${run.id}:0`,
        modelVersion: 'f2-fake-model',
        // Required legacy schema field, deliberately empty in the F2 Fake
        // fixture: it is not an object key and never maps to storage.
        inputObjectKey: '',
      },
      {
        processingRunId: run.id,
        planRevision: 0,
        chunkIndex: 1,
        startMs: 40_000,
        endMs: 80_000,
        status: 'SUCCEEDED',
        idempotencyKey: `f2-runtime:${run.id}:1`,
        modelVersion: 'f2-fake-model',
        inputObjectKey: '',
      },
    ],
  })
  return { asset, run }
}

describe('isolated v2 HANDOFF_EVIDENCING runtime', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "MossCallbackReceipt", "ProcessingChunk", "ProcessingRun",
        "HandoffEvidence", "AlignmentJob", "HandoffAssessment", "ProcessingHandoff",
        "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession", "OtpChallenge", "User"
      CASCADE
    `)
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('strict-segment acceptance materializes evidence and advances only to MERGING (not Fake alignment)', async () => {
    const { asset, run } = await createTwoChunkRun()
    const runtime = makeRuntime(new FakeStrictAssessmentInputProvider(), new InMemoryAlignmentAdapter())

    await expect(advanceV2HandoffEvidencing(runtime, {
      processingRunId: run.id,
      mediaAssetId: asset.id,
    })).resolves.toEqual({ kind: 'advanced', handoffCount: 1 })

    const persistedRun = await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })
    const evidence = await database.handoffEvidence.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(persistedRun).toMatchObject({ status: 'PROCESSING', stage: 'MERGING', leaseOwner: null })
    expect(evidence).toMatchObject({
      decision: 'accepted',
      evidenceType: 'strict_segment',
      candidateCount: 1,
      previousAsrObjectKey: '',
      previousAsrVersionId: null,
      previousAsrChecksum: null,
      nextAsrObjectKey: '',
      nextAsrVersionId: null,
      nextAsrChecksum: null,
      normalizedAudioVersionId: null,
      normalizedAudioChecksum: null,
      rawObjectKey: null,
      rawVersionId: null,
      rawChecksum: null,
    })
    expect(await database.alignmentJob.count({ where: { handoff: { processingRunId: run.id } } })).toBe(0)
  })

  it('fails closed after an accepted alignment Fake result without an authorized raw identity', async () => {
    const { asset, run } = await createTwoChunkRun()
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    let instant = new Date('2026-08-27T00:00:00.000Z')
    const runtime = makeRuntime(assessment, alignment, () => instant)
    const input = { processingRunId: run.id, mediaAssetId: asset.id }

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })

    const job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(job).toMatchObject({ status: 'POLLING', attempt: 1 })
    expect(job.externalJobId).toBeTruthy()
    expect(alignment.queryCount()).toBe(1)
    // The persisted nextPollAt is a real fence, not merely diagnostic data.
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    expect(alignment.queryCount()).toBe(1)
    alignment.scriptOutcome(job.externalJobId!, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 800 },
    })
    instant = new Date(instant.getTime() + 1_000)

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'failed', errorCode: 'transcript_incomplete' })

    expect(await database.handoffEvidence.count({ where: { handoff: { processingRunId: run.id } } })).toBe(0)
    expect(await database.processingHandoff.findFirstOrThrow({ where: { processingRunId: run.id } })).toMatchObject({
      status: 'FAILED', errorCode: 'alignment_raw_unavailable', leaseOwner: null, leaseExpiresAt: null,
    })
    expect(await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'FAILED', errorCode: 'alignment_raw_unavailable', nextPollAt: null, nextAttemptAt: null,
    })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'FAILED', stage: 'HANDOFF_EVIDENCING', errorCode: 'transcript_incomplete', leaseOwner: null, leaseExpiresAt: null,
    })
    expect(await database.transcriptVersion.count({ where: { processingRunId: run.id } })).toBe(0)
    expect(await database.subtitleCue.count()).toBe(0)
    expect(await database.privateLesson.count()).toBe(0)
    const queryCountAfterFailure = alignment.queryCount()
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'skipped', handoffCount: 0 })
    expect(alignment.queryCount()).toBe(queryCountAfterFailure)
  })

  it('adopts a provider reservation after a lost submit response, then fails closed without duplicate submission', async () => {
    const { asset, run } = await createTwoChunkRun()
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    alignment.scriptResponseLossOnce()
    let instant = new Date('2026-08-27T00:00:00.000Z')
    const runtime = makeRuntime(assessment, alignment, () => instant)
    const input = { processingRunId: run.id, mediaAssetId: asset.id }

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })

    const job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(alignment.submittedCount()).toBe(1)
    expect(job.externalJobId).toBe('fake-align-1')
    alignment.scriptOutcome(job.externalJobId!, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 800 },
    })
    instant = new Date(instant.getTime() + 1_000)

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'failed', errorCode: 'transcript_incomplete' })
    expect(alignment.submittedCount()).toBe(1)
    expect(await database.alignmentJob.count({ where: { handoff: { processingRunId: run.id } } })).toBe(1)
    expect(await database.handoffEvidence.count({ where: { handoff: { processingRunId: run.id } } })).toBe(0)
    expect(await database.processingHandoff.findFirstOrThrow({ where: { processingRunId: run.id } })).toMatchObject({
      status: 'FAILED', errorCode: 'alignment_raw_unavailable', leaseOwner: null, leaseExpiresAt: null,
    })
    expect(await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'FAILED', errorCode: 'alignment_raw_unavailable', nextPollAt: null, nextAttemptAt: null,
    })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'FAILED', stage: 'HANDOFF_EVIDENCING', errorCode: 'transcript_incomplete', leaseOwner: null, leaseExpiresAt: null,
    })
    expect(await database.transcriptVersion.count({ where: { processingRunId: run.id } })).toBe(0)
    expect(await database.subtitleCue.count()).toBe(0)
    expect(await database.privateLesson.count()).toBe(0)
    const queryCountAfterFailure = alignment.queryCount()
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'skipped', handoffCount: 0 })
    expect(alignment.queryCount()).toBe(queryCountAfterFailure)
  })

  it('retries only transient query failures up to attempt three against one immutable reservation, then fails closed', async () => {
    const { asset, run } = await createTwoChunkRun()
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    let instant = new Date('2026-08-27T00:00:00.000Z')
    const runtime = makeRuntime(assessment, alignment, () => instant)
    const input = { processingRunId: run.id, mediaAssetId: asset.id }

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    let job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    const externalJobId = job.externalJobId!
    alignment.scriptQueryErrorOnce(externalJobId, 'alignment_timeout')
    instant = new Date(instant.getTime() + 1_000)

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    job = await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(job).toMatchObject({ status: 'POLLING', attempt: 2, externalJobId, errorCode: 'alignment_timeout' })
    expect(job.nextAttemptAt).toEqual(new Date('2026-08-27T00:00:02.000Z'))
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    expect(alignment.submittedCount()).toBe(1)

    instant = new Date(instant.getTime() + 1_000)
    alignment.scriptQueryErrorOnce(externalJobId, 'alignment_rate_limited')
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    job = await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(job).toMatchObject({ status: 'POLLING', attempt: 3, externalJobId, errorCode: 'alignment_rate_limited' })

    instant = new Date(instant.getTime() + 1_000)
    alignment.scriptQueryErrorOnce(externalJobId, 'alignment_unavailable')

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'failed', errorCode: 'transcript_incomplete' })
    expect(alignment.submittedCount()).toBe(1)
    expect(await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'FAILED', attempt: 3, externalJobId, errorCode: 'alignment_unavailable',
    })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'transcript_incomplete' })
    expect(await database.handoffEvidence.count({ where: { handoff: { processingRunId: run.id } } })).toBe(0)
  })

  it('retries transient lookup and submit failures with the same pending job identity before any reservation exists', async () => {
    const { asset, run } = await createTwoChunkRun()
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    alignment.scriptFindErrorOnce('alignment_unavailable')
    alignment.scriptSubmitErrorOnce('alignment_rate_limited')
    let instant = new Date('2026-08-27T00:00:00.000Z')
    const runtime = makeRuntime(assessment, alignment, () => instant)
    const input = { processingRunId: run.id, mediaAssetId: asset.id }

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    let job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(job).toMatchObject({ status: 'PENDING', attempt: 2, externalJobId: null, errorCode: 'alignment_unavailable' })
    const immutableIdentity = { idempotencyKey: job.idempotencyKey, correlationHandle: job.correlationHandle }
    expect(alignment.submittedCount()).toBe(0)

    instant = new Date(instant.getTime() + 1_000)
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    job = await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(job).toMatchObject({ status: 'PENDING', attempt: 3, externalJobId: null, errorCode: 'alignment_rate_limited', ...immutableIdentity })
    expect(alignment.submittedCount()).toBe(0)

    instant = new Date(instant.getTime() + 1_000)
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    job = await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(job).toMatchObject({ status: 'POLLING', attempt: 3, ...immutableIdentity })
    expect(job.externalJobId).toBe('fake-align-1')
    expect(alignment.submittedCount()).toBe(1)
  })

  it('fails a non-retryable alignment result without issuing another submission', async () => {
    const { asset, run } = await createTwoChunkRun()
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    let instant = new Date('2026-08-27T00:00:00.000Z')
    const runtime = makeRuntime(assessment, alignment, () => instant)
    const input = { processingRunId: run.id, mediaAssetId: asset.id }

    await advanceV2HandoffEvidencing(runtime, input)
    const job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    alignment.scriptOutcome(job.externalJobId!, {
      state: 'FAILED',
      result: { decision: 'insufficient', decisionCode: 'alignment_input_mismatch', candidateCount: 0, anchorCount: 0, coverageMs: 0 },
    })
    instant = new Date(instant.getTime() + 1_000)

    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'failed', errorCode: 'transcript_incomplete' })
    expect(alignment.submittedCount()).toBe(1)
  })

  it('cancels locally and fails closed when a late accepted result appears', async () => {
    const { asset, run } = await createTwoChunkRun()
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    const runtime = makeRuntime(assessment, alignment)

    const input = { processingRunId: run.id, mediaAssetId: asset.id }
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'waiting', handoffCount: 1 })
    const job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })

    await database.processingRun.update({
      where: { id: run.id },
      data: { status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null },
    })
    await expect(cancelV2HandoffEvidencing(runtime, input)).resolves.toMatchObject({ kind: 'cancelled' })

    // Simulate a provider result arriving after the cancellation fence.
    alignment.scriptOutcome(job.externalJobId!, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 800 },
    })
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'skipped', handoffCount: 0 })

    const handoff = await database.processingHandoff.findFirstOrThrow({ where: { processingRunId: run.id } })
    expect(handoff.status).toBe('CANCELLED')
    const cancelledJob = await database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(cancelledJob).toMatchObject({ status: 'CANCELLED', nextPollAt: null, nextAttemptAt: null })
    expect(cancelledJob.externalCancelledAt).toBeInstanceOf(Date)
    expect(await database.handoffEvidence.count({ where: { handoff: { processingRunId: run.id } } })).toBe(0)
    expect(alignment.submittedCount()).toBe(1)
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'CANCELLED', stage: 'HANDOFF_EVIDENCING', leaseOwner: null, leaseExpiresAt: null,
    })
    expect(await database.transcriptVersion.count({ where: { processingRunId: run.id } })).toBe(0)
    expect(await database.subtitleCue.count()).toBe(0)
    expect(await database.privateLesson.count()).toBe(0)
    const queryCountAfterLateResult = alignment.queryCount()
    await expect(advanceV2HandoffEvidencing(runtime, input)).resolves.toEqual({ kind: 'skipped', handoffCount: 0 })
    expect(alignment.queryCount()).toBe(queryCountAfterLateResult)
  })
})
