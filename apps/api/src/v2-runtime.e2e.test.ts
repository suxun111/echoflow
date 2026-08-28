/**
 * F2 API coverage. This test boots only Nest + the disposable PostgreSQL
 * database; it never calls upload, playback, storage, MOSS, FFmpeg or a
 * worker. The v2 endpoint itself is test-only by configuration.
 */

import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { MediaAssetViewSchema } from '@online-learning/contracts'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApplication } from './bootstrap'
import type { RequestLog } from './common/request-context'
import { DatabaseService } from './database/database.module'
import { createTestEnv } from './test/test-env'

type LoginResult = { accessToken: string; user: { id: string } }

describe('F2 v2 test-only enrollment and cancellation API', () => {
  let app: INestApplication | undefined
  let database: DatabaseService
  const requestLogs: RequestLog[] = []

  async function start(overrides: Record<string, string | undefined> = {}) {
    const env = createTestEnv(overrides)
    app = await createApplication(env, { writeRequestLog: (entry) => requestLogs.push(entry) })
    database = app.get(DatabaseService)
  }

  async function restart(overrides: Record<string, string | undefined> = {}) {
    await app?.close()
    await start(overrides)
  }

  async function cleanDatabase() {
    requestLogs.length = 0
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "MossCallbackReceipt", "ProcessingChunk", "ProcessingRun",
        "HandoffEvidence", "AlignmentJob", "HandoffAssessment", "ProcessingHandoff",
        "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession", "OtpChallenge", "User"
      CASCADE
    `)
  }

  async function login(phone: string): Promise<LoginResult> {
    const otp = await request(app!.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone })
      .expect(200)
    const verified = await request(app!.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code: otp.body.developmentCode })
      .expect(200)
    return { accessToken: verified.body.accessToken, user: verified.body.user }
  }

  async function createPlayableAsset(ownerId: string, title = 'F2 synthetic asset') {
    return database.mediaAsset.create({
      data: {
        ownerId, title, originalName: 'synthetic-f2.mp4', status: 'PLAYABLE', durationMs: 60_000,
      },
    })
  }

  beforeEach(async () => {
    if (!app) await start()
    await cleanDatabase()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('keeps v2 disabled outside the explicit test Fake gate and rejects a non-allowlisted owner', async () => {
    await restart({ V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED: 'false', V2_TRANSCRIPT_ALLOWLIST: '' })
    const owner = await login('+8613800001011')
    const asset = await createPlayableAsset(owner.user.id)
    const enrollmentKey = 'v2-disabled-sentinel-0001'

    const disabled = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/enroll-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', enrollmentKey)
      .expect(503)
    expect(disabled.body).toMatchObject({ code: 'service_unavailable' })
    expect(await database.processingRun.count({ where: { mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v2' } })).toBe(0)

    await restart({ V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED: 'true', V2_TRANSCRIPT_ALLOWLIST: '' })
    const denied = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/enroll-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', enrollmentKey)
      .expect(403)
    expect(denied.body).toMatchObject({ code: 'enrollment_not_allowlisted' })
    expect(await database.processingRun.count({ where: { mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v2' } })).toBe(0)
  })

  it('enrolls once, redacts the raw key, isolates owner access, exposes v2 status and fences cancellation locally', async () => {
    await restart({ V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED: 'true', V2_TRANSCRIPT_ALLOWLIST: '' })
    const owner = await login('+8613800001012')
    const other = await login('+8613800001013')
    const asset = await createPlayableAsset(owner.user.id)
    await restart({
      V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED: 'true',
      V2_TRANSCRIPT_ALLOWLIST: `${owner.user.id},${other.user.id}`,
    })
    const enrollmentKey = 'raw-enrollment-sentinel-0002'

    const first = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/enroll-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', enrollmentKey)
      .expect(201)
    expect(first.body).toMatchObject({ enrolled: true, pipelineVersion: 'g3-transcript-v2', duplicate: false })
    expect(first.body).not.toHaveProperty('processingRunId')
    const run = await database.processingRun.findFirstOrThrow({
      where: { mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v2' },
    })
    const runId = run.id

    const replay = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/enroll-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', enrollmentKey)
      .expect(201)
    expect(replay.body).toEqual({ enrolled: true, pipelineVersion: 'g3-transcript-v2', duplicate: true })

    const differentKey = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/enroll-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', 'raw-enrollment-different-0003')
      .expect(409)
    expect(differentKey.body).toMatchObject({ code: 'transcript_pipeline_conflict' })

    const wrongOwner = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/enroll-v2`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .set('idempotency-key', 'other-owner-enrollment-0004')
      .expect(404)
    expect(wrongOwner.body).toMatchObject({ code: 'not_found' })

    const processEvent = await database.outboxEvent.findFirstOrThrow({
      where: { aggregateId: runId, eventType: 'media.transcript_process.v2' },
    })
    expect(run).toMatchObject({ pipelineVersion: 'g3-transcript-v2', stage: 'HANDOFF_EVIDENCING', status: 'QUEUED' })
    expect(processEvent.idempotencyKey).not.toBe(enrollmentKey)
    expect(JSON.stringify({ first: first.body, replay: replay.body, event: processEvent })).not.toContain(enrollmentKey)
    expect(processEvent.payload).toEqual({ v2JobHandle: run.requestId })
    expect(JSON.stringify(processEvent.payload)).not.toContain(asset.id)
    expect(JSON.stringify(processEvent.payload)).not.toContain(runId)
    const enrollmentLog = requestLogs.find((entry) => entry.path.endsWith('/transcript/enroll-v2'))
    expect(enrollmentLog?.path).not.toContain(asset.id)
    expect(enrollmentLog?.path).toContain('/:id/transcript/enroll-v2')

    const view = await request(app!.getHttpServer())
      .get(`/api/v1/media-assets/${asset.id}`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
    const parsed = MediaAssetViewSchema.parse(view.body)
    expect(parsed.transcriptProcessing).toMatchObject({ status: 'queued', stage: 'handoff_evidencing' })
    expect(parsed.transcriptProcessing?.handoffCounts).toMatchObject({
      total: 0, evidenced: 0, hProviderWord: 0,
    })

    const v1Sentinel = await database.outboxEvent.create({
      data: {
        aggregateType: 'ProcessingRun', aggregateId: 'v1-sentinel-run', eventType: 'media.transcript_cancel_requested',
        idempotencyKey: 'v1-outbox-must-not-change-0001', payload: { mediaAssetId: asset.id, processingRunId: 'v1-sentinel-run' },
      },
    })
    const cancelKey = 'raw-cancel-sentinel-0005'
    const cancelled = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/cancel-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', cancelKey)
      .expect(201)
    expect(cancelled.body).toEqual({ cancelled: true, pipelineVersion: 'g3-transcript-v2', duplicate: false })

    expect(await database.processingRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'CANCELLED', errorCode: 'processing_cancelled' })
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: processEvent.id } })).toMatchObject({ status: 'FAILED', lastError: 'processing_cancelled' })
    const cancelEvent = await database.outboxEvent.findFirstOrThrow({
      where: { aggregateId: runId, eventType: 'media.transcript_cancel_requested.v2' },
    })
    expect(cancelEvent).toMatchObject({ status: 'PENDING' })
    expect(JSON.stringify(cancelEvent)).not.toContain(cancelKey)
    expect(cancelEvent.payload).toEqual({ v2JobHandle: run.requestId })
    expect(JSON.stringify(cancelEvent.payload)).not.toContain(asset.id)
    expect(JSON.stringify(cancelEvent.payload)).not.toContain(runId)
    expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: v1Sentinel.id } })).toMatchObject({ status: 'PENDING' })
    const replayCancel = await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/cancel-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', cancelKey)
      .expect(201)
    expect(replayCancel.body).toEqual({ cancelled: true, pipelineVersion: 'g3-transcript-v2', duplicate: true })
    await request(app!.getHttpServer())
      .post(`/api/v1/media-assets/${asset.id}/transcript/cancel-v2`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', 'raw-cancel-different-0006')
      .expect(409)

    const replayRecord = await database.idempotencyRecord.findFirstOrThrow({
      where: { ownerId: owner.user.id, scope: 'transcript-v2-cancel' },
    })
    expect(JSON.stringify(replayRecord)).not.toContain(cancelKey)
    expect(await database.processingRun.count({ where: { mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v2' } })).toBe(1)
  })
})
