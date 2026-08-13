import 'reflect-metadata'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import { UserRole } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApplication } from './bootstrap'
import type { RequestLog } from './common/request-context'
import { DatabaseService } from './database/database.module'
import { StorageService } from './storage/storage.module'
import { createTestEnv } from './test/test-env'

const env = createTestEnv()
const minio = new MinioStorageProvider({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  bucket: env.MINIO_BUCKET,
})

type LoginResult = {
  accessToken: string
  cookie: string
  rawCookie: string
  developmentCode: string
  user: { id: string; phone: string; role: string }
}

describe('EchoFlow real PostgreSQL, auth, upload and owner boundary', () => {
  let app: INestApplication
  let database: DatabaseService
  const requestLogs: RequestLog[] = []

  async function startApp() {
    app = await createApplication(env, { writeRequestLog: (entry) => requestLogs.push(entry) })
    database = app.get(DatabaseService)
  }

  async function restartApp() {
    await app.close()
    await startApp()
  }

  async function cleanDatabase() {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "MossCallbackReceipt", "ProcessingChunk", "ProcessingRun",
        "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession",
        "OtpChallenge", "User"
      CASCADE
    `)
  }

  async function login(phone: string): Promise<LoginResult> {
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone })
      .expect(200)
    expect(otp.body.developmentCode).toMatch(/^\d{6}$/)

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code: otp.body.developmentCode })
      .expect(200)
    const rawCookie = String(verified.headers['set-cookie'][0])
    expect(verified.body.refreshToken).toBeUndefined()
    return {
      accessToken: verified.body.accessToken,
      cookie: rawCookie.split(';')[0],
      rawCookie,
      developmentCode: otp.body.developmentCode,
      user: verified.body.user,
    }
  }

  beforeAll(async () => {
    await minio.ensureBucket()
    await minio.ensureVersioning()
    await startApp()
  })
  beforeEach(async () => {
    requestLogs.length = 0
    await cleanDatabase()
  })
  afterAll(async () => {
    if (app) await app.close()
  })

  it('loads the real bootstrap prefix, requestId, readiness and explicit CORS allowlist', async () => {
    const health = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-request-id', 'g1-health-request')
      .set('origin', 'http://localhost:4173')
      .expect(200)
    expect(health.headers['x-request-id']).toBe('g1-health-request')
    expect(health.headers['access-control-allow-origin']).toBe('http://localhost:4173')
    expect(requestLogs).toContainEqual(expect.objectContaining({
      type: 'http_request', requestId: 'g1-health-request', method: 'GET', path: '/api/v1/health', status: 200,
    }))
    expect(Object.keys(requestLogs[0]).sort()).toEqual(['durationMs', 'method', 'path', 'requestId', 'status', 'type'])
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200)

    const deniedOrigin = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('origin', 'https://attacker.example')
      .expect(200)
    expect(deniedOrigin.headers['access-control-allow-origin']).toBeUndefined()

    const oldPrefix = await request(app.getHttpServer()).get('/api/health').expect(404)
    expect(oldPrefix.body).toMatchObject({ code: 'not_found' })
    expect(oldPrefix.body.requestId).toBeTruthy()
  })

  it('returns stable validation errors and requires auth by default', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone: '13800000000' })
      .expect(400)
    expect(invalid.body).toMatchObject({ code: 'invalid_request', message: '请求参数无效' })
    expect(invalid.body.requestId).toBeTruthy()

    const privateResponse = await request(app.getHttpServer()).get('/api/v1/users/me').expect(401)
    expect(privateResponse.body).toMatchObject({ code: 'unauthenticated' })

    const session = await login('+8613800000011')
    const malformedId = await request(app.getHttpServer())
      .get('/api/v1/lessons/not-a-uuid')
      .set('authorization', `Bearer ${session.accessToken}`)
      .expect(400)
    expect(malformedId.body).toMatchObject({ code: 'invalid_request' })
    expect(malformedId.body.requestId).toBeTruthy()
  })

  it('persists OTP/session state and rotates an HttpOnly refresh cookie after app restart', async () => {
    const session = await login('+8613800000001')
    expect(session.rawCookie).toContain('HttpOnly')
    expect(session.rawCookie).toContain('SameSite=Lax')
    expect(session.rawCookie).toContain('Path=/api/v1/auth')
    expect(session.rawCookie).not.toContain('Secure')

    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('authorization', `Bearer ${session.accessToken}`)
      .expect(200, session.user)
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .send({ phone: session.user.phone, code: session.developmentCode })
      .expect(401)

    await restartApp()
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('cookie', session.cookie)
      .expect(200)
    expect(refreshed.body.refreshToken).toBeUndefined()
    expect(refreshed.body.user.id).toBe(session.user.id)
    expect(String(refreshed.headers['set-cookie'][0]).split(';')[0]).not.toBe(session.cookie)
  })

  it('limits OTP attempts, rejects expired codes and rate-limits repeated requests', async () => {
    const phone = '+8613800000002'
    const otp = await request(app.getHttpServer()).post('/api/v1/auth/otp/request').send({ phone }).expect(200)
    const rateLimited = await request(app.getHttpServer()).post('/api/v1/auth/otp/request').send({ phone }).expect(429)
    expect(rateLimited.body).toMatchObject({ code: 'rate_limited' })
    expect(rateLimited.body.requestId).toBeTruthy()
    const incorrectCode = otp.body.developmentCode === '000000' ? '000001' : '000000'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/api/v1/auth/otp/verify').send({ phone, code: incorrectCode }).expect(401)
    }
    const exhausted = await database.otpChallenge.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: 'desc' } })
    expect(exhausted.attempts).toBe(5)
    expect(exhausted.consumedAt).not.toBeNull()
    expect(exhausted.codeHash).not.toContain(otp.body.developmentCode)

    const expiredPhone = '+8613800000003'
    const expired = await request(app.getHttpServer()).post('/api/v1/auth/otp/request').send({ phone: expiredPhone }).expect(200)
    await database.otpChallenge.updateMany({ where: { phone: expiredPhone }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .send({ phone: expiredPhone, code: expired.body.developmentCode })
      .expect(401)
    expect(response.body.message).toBe('验证码已过期')
  })

  it('revokes the entire refresh family when a rotated token is replayed', async () => {
    const session = await login('+8613800000004')
    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('cookie', session.cookie)
      .expect(200)
    const nextCookie = String(rotated.headers['set-cookie'][0]).split(';')[0]

    const replay = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('cookie', session.cookie)
      .expect(401)
    expect(replay.body.message).toContain('重放')
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('cookie', nextCookie).expect(401)
    await request(app.getHttpServer()).get('/api/v1/users/me').set('authorization', `Bearer ${rotated.body.accessToken}`).expect(401)
  })

  it('treats concurrent use of one refresh token as replay and revokes the winner', async () => {
    const session = await login('+8613800000012')
    const responses = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/auth/refresh').set('cookie', session.cookie),
      request(app.getHttpServer()).post('/api/v1/auth/refresh').set('cookie', session.cookie),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401])

    const winner = responses.find((response) => response.status === 200)!
    const replay = responses.find((response) => response.status === 401)!
    expect(replay.body).toMatchObject({ code: 'unauthenticated' })
    expect(replay.body.message).toContain('重放')
    expect(replay.body.requestId).toBeTruthy()

    const winnerCookie = String(winner.headers['set-cookie'][0]).split(';')[0]
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('cookie', winnerCookie).expect(401)
    await request(app.getHttpServer()).get('/api/v1/users/me').set('authorization', `Bearer ${winner.body.accessToken}`).expect(401)
  })

  it('rejects tampered, wrongly signed, wrongly scoped and expired access tokens', async () => {
    const session = await login('+8613800000005')
    const [header, payload, signature] = session.accessToken.split('.')
    const tamperedSignature = `${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`
    const tampered = `${header}.${payload}.${tamperedSignature}`
    await request(app.getHttpServer()).get('/api/v1/users/me').set('authorization', `Bearer ${tampered}`).expect(401)

    const common = { subject: session.user.id, algorithm: 'HS256' as const, audience: 'echoflow-web', expiresIn: 60 }
    const wrongSecret = jwt.sign({ familyId: 'not-a-family' }, 'wrong-secret-that-is-long-enough-for-the-test', { ...common, issuer: 'echoflow-api' })
    const wrongIssuer = jwt.sign({ familyId: 'not-a-family' }, env.ACCESS_TOKEN_SECRET, { ...common, issuer: 'attacker' })
    const wrongAudience = jwt.sign({ familyId: 'not-a-family' }, env.ACCESS_TOKEN_SECRET, { ...common, audience: 'attacker', issuer: 'echoflow-api' })
    const expired = jwt.sign({ familyId: 'not-a-family' }, env.ACCESS_TOKEN_SECRET, { ...common, issuer: 'echoflow-api', expiresIn: -1 })
    for (const token of [wrongSecret, wrongIssuer, wrongAudience, expired]) {
      await request(app.getHttpServer()).get('/api/v1/users/me').set('authorization', `Bearer ${token}`).expect(401)
    }
  })

  it('revokes the server-side session family and clears the refresh cookie on logout', async () => {
    const session = await login('+8613800000009')
    const loggedOut = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('cookie', session.cookie)
      .expect(204)
    expect(String(loggedOut.headers['set-cookie'][0])).toContain('Max-Age=0')
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('cookie', session.cookie).expect(401)
    await request(app.getHttpServer()).get('/api/v1/users/me').set('authorization', `Bearer ${session.accessToken}`).expect(401)
  })

  it('enforces owner scope as not-found and ignores client supplied ownerId', async () => {
    const owner = await login('+8613800000006')
    const other = await login('+8613800000007')
    const asset = await database.mediaAsset.create({
      data: { ownerId: owner.user.id, title: 'Private podcast', originalName: 'podcast.mp4' },
    })
    const lesson = await database.privateLesson.create({
      data: { ownerId: owner.user.id, mediaAssetId: asset.id, title: 'Private podcast' },
    })

    await request(app.getHttpServer())
      .get(`/api/v1/lessons/${lesson.id}?ownerId=${other.user.id}`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
    const denied = await request(app.getHttpServer())
      .get(`/api/v1/lessons/${lesson.id}?ownerId=${owner.user.id}`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)
    expect(denied.body.code).toBe('not_found')
  })

  it('enforces learner/admin RBAC without granting private media access', async () => {
    const learner = await login('+8613800000008')
    const privateOwner = await login('+8613800000010')
    const forbidden = await request(app.getHttpServer())
      .get('/api/v1/admin/audit-events')
      .set('authorization', `Bearer ${learner.accessToken}`)
      .expect(403)
    expect(forbidden.body).toMatchObject({ code: 'forbidden' })
    expect(forbidden.body.requestId).toBeTruthy()

    const asset = await database.mediaAsset.create({
      data: { ownerId: privateOwner.user.id, title: 'Owner only', originalName: 'owner-only.mp4' },
    })
    const lesson = await database.privateLesson.create({
      data: { ownerId: privateOwner.user.id, mediaAssetId: asset.id, title: 'Owner only' },
    })

    await database.user.update({ where: { id: learner.user.id }, data: { role: UserRole.ADMIN } })
    const admin = await request(app.getHttpServer())
      .get('/api/v1/admin/audit-events')
      .set('authorization', `Bearer ${learner.accessToken}`)
      .expect(200)
    expect(Array.isArray(admin.body.items)).toBe(true)
    await request(app.getHttpServer())
      .get(`/api/v1/lessons/${lesson.id}`)
      .set('authorization', `Bearer ${learner.accessToken}`)
      .expect(404)
  })

  it('rejects cross-owner and cross-aggregate relations at the PostgreSQL boundary', async () => {
    const owner = await login('+8613800000013')
    const other = await login('+8613800000014')
    const upload = await database.uploadSession.create({
      data: {
        ownerId: owner.user.id,
        originalName: 'podcast.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024n,
        objectKey: `owners/${owner.user.id}/upload.mp4`,
        partSizeBytes: 512n,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await expect(database.mediaAsset.create({
      data: { ownerId: other.user.id, uploadSessionId: upload.id, title: 'Cross owner', originalName: 'podcast.mp4' },
    })).rejects.toMatchObject({ code: 'P2003' })

    const firstAsset = await database.mediaAsset.create({
      data: { ownerId: owner.user.id, title: 'First', originalName: 'first.mp4' },
    })
    const secondAsset = await database.mediaAsset.create({
      data: { ownerId: owner.user.id, title: 'Second', originalName: 'second.mp4' },
    })
    await expect(database.processingRun.create({
      data: { ownerId: other.user.id, mediaAssetId: firstAsset.id, pipelineVersion: 'g1-test' },
    })).rejects.toMatchObject({ code: 'P2003' })

    const [firstTranscriptRun, secondTranscriptRun, conflictingTranscriptRun] = await Promise.all([
      database.processingRun.create({ data: { ownerId: owner.user.id, mediaAssetId: firstAsset.id, pipelineVersion: 'g3-test-first' } }),
      database.processingRun.create({ data: { ownerId: owner.user.id, mediaAssetId: secondAsset.id, pipelineVersion: 'g3-test-second' } }),
      database.processingRun.create({ data: { ownerId: owner.user.id, mediaAssetId: firstAsset.id, pipelineVersion: 'g3-test-conflict' } }),
    ])
    const firstTranscript = await database.transcriptVersion.create({
      data: {
        mediaAssetId: firstAsset.id, processingRunId: firstTranscriptRun.id, version: 1, durationMs: 1_000,
        pipelineVersion: 'g3-test-first', modelVersion: 'fake-moss',
      },
    })
    const secondTranscript = await database.transcriptVersion.create({
      data: {
        mediaAssetId: secondAsset.id, processingRunId: secondTranscriptRun.id, version: 1, durationMs: 1_000,
        pipelineVersion: 'g3-test-second', modelVersion: 'fake-moss',
      },
    })
    await database.transcriptVersion.update({ where: { id: firstTranscript.id }, data: { status: 'ACTIVE' } })
    await expect(database.transcriptVersion.create({
      data: {
        mediaAssetId: firstAsset.id, processingRunId: conflictingTranscriptRun.id, version: 2, durationMs: 1_000,
        pipelineVersion: 'g3-test-conflict', modelVersion: 'fake-moss', status: 'ACTIVE',
      },
    })).rejects.toMatchObject({ code: 'P2002' })
    await expect(database.privateLesson.create({
      data: {
        ownerId: owner.user.id,
        mediaAssetId: firstAsset.id,
        transcriptVersionId: secondTranscript.id,
        title: 'Cross transcript',
      },
    })).rejects.toMatchObject({ code: 'P2003' })

    const firstLesson = await database.privateLesson.create({
      data: {
        ownerId: owner.user.id,
        mediaAssetId: firstAsset.id,
        transcriptVersionId: firstTranscript.id,
        title: 'First',
      },
    })
    const secondLesson = await database.privateLesson.create({
      data: {
        ownerId: owner.user.id,
        mediaAssetId: secondAsset.id,
        transcriptVersionId: secondTranscript.id,
        title: 'Second',
      },
    })
    const secondUnit = await database.learningUnit.create({
      data: { lessonId: secondLesson.id, order: 0, startMs: 0, endMs: 1_000, firstCueOrder: 0, lastCueOrder: 0 },
    })
    const secondCue = await database.subtitleCue.create({
      data: { transcriptVersionId: secondTranscript.id, order: 0, startMs: 0, endMs: 1_000, text: 'Second', words: [] },
    })

    await expect(database.learningProgress.create({
      data: { ownerId: other.user.id, lessonId: firstLesson.id, completedCueIds: [] },
    })).rejects.toMatchObject({ code: 'P2003' })
    await expect(database.learningProgress.create({
      data: { ownerId: owner.user.id, lessonId: firstLesson.id, currentUnitId: secondUnit.id, completedCueIds: [] },
    })).rejects.toMatchObject({ code: 'P2003' })
    await expect(database.learningProgress.create({
      data: {
        ownerId: owner.user.id,
        lessonId: firstLesson.id,
        currentTranscriptVersionId: firstTranscript.id,
        currentCueId: secondCue.id,
        completedCueIds: [],
      },
    })).rejects.toMatchObject({ code: 'P2003' })
  })

  it('uses real MinIO multipart, idempotent complete and owner-scoped signed Range playback', async () => {
    const owner = await login('+8613800000020')
    const other = await login('+8613800000021')
    const bytes = Buffer.from('echoflow-private-video-range-evidence')
    const created = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'private-podcast.mp4', contentType: 'video/mp4', sizeBytes: bytes.length,
        fileFingerprint: 'a'.repeat(64), rightsConfirmed: true,
      })
      .expect(201)
    expect(created.body).toMatchObject({ status: 'created', partCount: 1, uploadedBytes: 0 })
    expect(created.body.objectKey).toBeUndefined()
    expect(created.body.providerUploadId).toBeUndefined()

    const signed = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/parts/sign`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(201)
    const put = await fetch(signed.body.parts[0].uploadUrl, { method: 'PUT', body: bytes })
    expect(put.status).toBe(200)
    const etag = put.headers.get('etag')
    expect(etag).toBeTruthy()

    // Simulate a lost part-record response: object storage remains authoritative.
    const noMissingParts = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/parts/sign`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(201)
    expect(noMissingParts.body.parts).toEqual([])
    await restartApp()
    const restoredUpload = await request(app.getHttpServer())
      .get(`/api/v1/uploads/${created.body.id}`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
    expect(restoredUpload.body).toMatchObject({ uploadedBytes: bytes.length, partCount: 1 })

    await request(app.getHttpServer())
      .get(`/api/v1/uploads/${created.body.id}`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/parts/sign`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(404)
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/parts/1`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .send({ sizeBytes: bytes.length, etag })
      .expect(404)
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/complete`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/cancel`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)

    const apiStorage = app.get(StorageService)
    const originalComplete = apiStorage.completeMultipartUpload.bind(apiStorage)
    let signalObjectCompleted!: () => void
    let releaseComplete!: () => void
    const objectCompleted = new Promise<void>((resolve) => { signalObjectCompleted = resolve })
    const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve })
    const completeSpy = vi.spyOn(apiStorage, 'completeMultipartUpload').mockImplementation(async (...args) => {
      const result = await originalComplete(...args)
      signalObjectCompleted()
      await completeGate
      return result
    })
    const completeRequests = [
      request(app.getHttpServer()).post(`/api/v1/uploads/${created.body.id}/complete`).set('authorization', `Bearer ${owner.accessToken}`).then((response) => response),
      request(app.getHttpServer()).post(`/api/v1/uploads/${created.body.id}/complete`).set('authorization', `Bearer ${owner.accessToken}`).then((response) => response),
    ]
    await objectCompleted
    const cancelRequest = request(app.getHttpServer()).post(`/api/v1/uploads/${created.body.id}/cancel`)
      .set('authorization', `Bearer ${owner.accessToken}`).then((response) => response)
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseComplete()
    const completed = await Promise.all(completeRequests)
    const cancelled = await cancelRequest
    completeSpy.mockRestore()
    expect(completed.map((response) => response.status)).toEqual([201, 201])
    expect(cancelled.status).toBe(409)
    expect(completed[0].body.mediaAssetId).toBe(completed[1].body.mediaAssetId)
    expect(await database.mediaAsset.count()).toBe(1)
    expect(await database.mediaObject.count()).toBe(1)
    const originalObject = await database.mediaObject.findFirstOrThrow()
    expect(originalObject.versionId).toBeTruthy()
    await expect(apiStorage.statObject(originalObject.objectKey, originalObject.versionId)).resolves.toMatchObject({ sizeBytes: bytes.length })
    expect(await database.processingRun.count()).toBe(1)
    expect(await database.outboxEvent.count({ where: { eventType: 'media.upload_verified' } })).toBe(1)

    const repeated = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${created.body.id}/complete`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(201)
    expect(repeated.body.mediaAssetId).toBe(completed[0].body.mediaAssetId)

    await request(app.getHttpServer())
      .post(`/api/v1/media-assets/${completed[0].body.mediaAssetId}/playback-url`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(409)
    await database.mediaAsset.update({ where: { id: completed[0].body.mediaAssetId }, data: { status: 'PLAYABLE', durationMs: 1_000 } })

    const denied = await request(app.getHttpServer())
      .post(`/api/v1/media-assets/${completed[0].body.mediaAssetId}/playback-url`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)
    expect(denied.body.requestId).toBeTruthy()

    await database.user.update({ where: { id: other.user.id }, data: { role: UserRole.ADMIN } })
    await request(app.getHttpServer())
      .post(`/api/v1/media-assets/${completed[0].body.mediaAssetId}/playback-url`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)

    const playback = await request(app.getHttpServer())
      .post(`/api/v1/media-assets/${completed[0].body.mediaAssetId}/playback-url`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(201)
    const ranged = await fetch(playback.body.playbackUrl, { headers: { Range: 'bytes=0-9' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toContain('bytes 0-9/')
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(0, 10))
    const unsignedUrl = new URL(playback.body.playbackUrl)
    unsignedUrl.search = ''
    expect((await fetch(unsignedUrl)).status).toBe(403)
  })

  it('recovers after provider completion without a database commit and rejects missing or mismatched objects', async () => {
    async function createUpload(phone: string, fingerprint: string, bytes: Buffer) {
      const owner = await login(phone)
      const created = await request(app.getHttpServer())
        .post('/api/v1/uploads')
        .set('authorization', `Bearer ${owner.accessToken}`)
        .send({
          fileName: 'recovery.mp4', contentType: 'video/mp4', sizeBytes: bytes.length,
          fileFingerprint: fingerprint.repeat(64), rightsConfirmed: true,
        })
        .expect(201)
      const upload = await database.uploadSession.findUniqueOrThrow({ where: { id: created.body.id } })
      return { owner, created, upload }
    }

    const crashBytes = Buffer.from('provider-completed-before-api-commit')
    const crash = await createUpload('+8613800000023', 'd', crashBytes)
    const crashUrl = await minio.createPartUploadUrl(crash.upload.objectKey, crash.upload.providerUploadId!, 1, 900)
    expect((await fetch(crashUrl, { method: 'PUT', body: crashBytes })).status).toBe(200)
    const crashParts = await minio.listMultipartParts(crash.upload.objectKey, crash.upload.providerUploadId!)
    await minio.completeMultipartUpload(crash.upload.objectKey, crash.upload.providerUploadId!, crashParts)

    // The object provider has committed, but no API transaction has run: this is the durable state after an API crash.
    await restartApp()
    const recovered = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${crash.created.body.id}/complete`)
      .set('authorization', `Bearer ${crash.owner.accessToken}`)
      .expect(201)
    expect(recovered.body.mediaAssetId).toBeTruthy()
    expect(await database.mediaAsset.count({ where: { uploadSessionId: crash.created.body.id } })).toBe(1)
    expect(await database.outboxEvent.count({ where: { aggregateId: recovered.body.mediaAssetId, eventType: 'media.upload_verified' } })).toBe(1)

    const missing = await createUpload('+8613800000024', 'e', Buffer.from('missing-object'))
    await minio.abortMultipartUpload(missing.upload.objectKey, missing.upload.providerUploadId!)
    const missingResponse = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${missing.created.body.id}/complete`)
      .set('authorization', `Bearer ${missing.owner.accessToken}`)
      .expect(503)
    expect(missingResponse.body).toMatchObject({ code: 'storage_unavailable' })
    expect(await database.mediaAsset.count({ where: { uploadSessionId: missing.created.body.id } })).toBe(0)

    const mismatchBytes = Buffer.from('expected-object-size')
    const mismatch = await createUpload('+8613800000025', 'f', mismatchBytes)
    await minio.abortMultipartUpload(mismatch.upload.objectKey, mismatch.upload.providerUploadId!)
    const directory = await mkdtemp(join(tmpdir(), 'echoflow-g2-object-mismatch-'))
    const wrongPath = join(directory, 'wrong.mp4')
    const wrongBytes = Buffer.concat([mismatchBytes, Buffer.from('-wrong-size')])
    await writeFile(wrongPath, wrongBytes)
    const wrongObject = await minio.uploadFile(mismatch.upload.objectKey, wrongPath, 'video/mp4')
    try {
      const mismatchResponse = await request(app.getHttpServer())
        .post(`/api/v1/uploads/${mismatch.created.body.id}/complete`)
        .set('authorization', `Bearer ${mismatch.owner.accessToken}`)
        .expect(422)
      expect(mismatchResponse.body).toMatchObject({ code: 'upload_object_mismatch' })
      expect(await database.mediaAsset.count({ where: { uploadSessionId: mismatch.created.body.id } })).toBe(0)
    } finally {
      await minio.remove(mismatch.upload.objectKey, wrongObject.versionId).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects active-upload conflicts, incomplete manifests and expired sessions without reviving them', async () => {
    const owner = await login('+8613800000022')
    const sizeBytes = env.UPLOAD_PART_SIZE_BYTES + 17
    const first = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'long.mp4', contentType: 'video/mp4', sizeBytes,
        fileFingerprint: 'b'.repeat(64), rightsConfirmed: true,
      })
      .expect(201)

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/uploads')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'different.mp4', contentType: 'video/mp4', sizeBytes: 10,
        fileFingerprint: 'c'.repeat(64), rightsConfirmed: true,
      })
      .expect(409)
    expect(conflict.body).toMatchObject({ code: 'upload_active_conflict' })

    const signed = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${first.body.id}/parts/sign`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(201)
    const part = Buffer.alloc(env.UPLOAD_PART_SIZE_BYTES, 7)
    const put = await fetch(signed.body.parts[0].uploadUrl, { method: 'PUT', body: part })
    const etag = put.headers.get('etag')
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/${first.body.id}/parts/1`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ sizeBytes: part.length, etag })
      .expect(201)
    const wrongPartSize = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${first.body.id}/parts/1`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ sizeBytes: part.length - 1, etag })
      .expect(422)
    expect(wrongPartSize.body).toMatchObject({ code: 'upload_part_invalid' })
    expect(wrongPartSize.body.requestId).toBeTruthy()
    const incomplete = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${first.body.id}/complete`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(409)
    expect(incomplete.body).toMatchObject({ code: 'upload_manifest_incomplete' })
    const stillUploading = await request(app.getHttpServer())
      .get(`/api/v1/uploads/${first.body.id}`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
    expect(stillUploading.body.status).toBe('uploading')

    await database.uploadSession.update({ where: { id: first.body.id }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    const expired = await request(app.getHttpServer())
      .post(`/api/v1/uploads/${first.body.id}/parts/sign`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [2] })
      .expect(410)
    expect(expired.body).toMatchObject({ code: 'upload_expired' })
  })

  it('authenticates MOSS callbacks over the raw body and persists replay protection before waking the worker', async () => {
    const owner = await login('+8613800000023')
    const asset = await database.mediaAsset.create({
      data: { ownerId: owner.user.id, title: 'Callback podcast', originalName: 'callback.mp4', status: 'PLAYABLE', durationMs: 30_000 },
    })
    const run = await database.processingRun.create({
      data: { ownerId: owner.user.id, mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v1', stage: 'TRANSCRIBING', status: 'PROCESSING' },
    })
    const chunk = await database.processingChunk.create({
      data: {
        processingRunId: run.id, chunkIndex: 0, startMs: 0, endMs: 30_000,
        idempotencyKey: 'g3:' + 'a'.repeat(64), modelVersion: 'fake-moss',
        externalJobId: 'moss-callback-job-1', inputObjectKey: 'private-redacted.wav', status: 'PROCESSING',
      },
    })
    const body = {
      externalJobId: chunk.externalJobId,
      idempotencyKey: chunk.idempotencyKey,
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
    }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'callback-nonce-1234'
    const sendCallback = (
      eventId: string,
      callbackNonce = nonce,
      callbackBody: typeof body = body,
      callbackSignature?: string,
    ) => {
      const raw = JSON.stringify(callbackBody)
      const signature = callbackSignature ?? `v1=${createHmac('sha256', env.MOSS_CALLBACK_SECRET!)
        .update(timestamp).update('.').update(callbackNonce).update('.').update(raw).digest('hex')}`
      return request(app.getHttpServer())
        .post('/api/v1/integrations/moss/callback')
        .set('content-type', 'application/json')
        .set('x-echoflow-event-id', eventId)
        .set('x-echoflow-timestamp', timestamp)
        .set('x-echoflow-nonce', callbackNonce)
        .set('x-echoflow-signature', signature)
        .send(raw)
    }

    await sendCallback('callback-event-1234').expect(201, { accepted: true, duplicate: false })
    await sendCallback('callback-event-1234').expect(201, { accepted: true, duplicate: true })
    expect(await database.mossCallbackReceipt.count()).toBe(1)
    expect(await database.outboxEvent.count({ where: { eventType: 'moss.callback_received' } })).toBe(1)
    expect((await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).nextPollAt).not.toBeNull()

    const replay = await sendCallback('callback-event-replay').expect(409)
    expect(replay.body).toMatchObject({ code: 'moss_callback_invalid' })
    const forged = await sendCallback('callback-event-forged', 'callback-nonce-5678', body, 'v1=' + '0'.repeat(64)).expect(401)
    expect(forged.body).toMatchObject({ code: 'moss_callback_invalid' })

    const olderFailure = {
      ...body, status: 'failed', errorCode: 'stale_failure',
      occurredAt: new Date(new Date(body.occurredAt).getTime() - 10_000).toISOString(),
    }
    await sendCallback('callback-event-older', 'callback-nonce-older', olderFailure)
      .expect(201, { accepted: true, duplicate: false, ignored: true })
    expect(await database.mossCallbackReceipt.count()).toBe(2)
    expect(await database.outboxEvent.count({ where: { eventType: 'moss.callback_received' } })).toBe(1)
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).toMatchObject({ status: 'PROCESSING', errorCode: null })
  })

  it('exposes only the owner ACTIVE transcript and retries only a persisted retryable failure', async () => {
    const owner = await login('+8613800000024')
    const other = await login('+8613800000025')
    const asset = await database.mediaAsset.create({
      data: { ownerId: owner.user.id, title: 'Private transcript', originalName: 'private.mp4', status: 'PLAYABLE', durationMs: 30_000 },
    })
    const run = await database.processingRun.create({
      data: {
        ownerId: owner.user.id, mediaAssetId: asset.id, pipelineVersion: 'g3-transcript-v1',
        status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY', completedAt: new Date(),
      },
    })
    const transcript = await database.transcriptVersion.create({
      data: {
        mediaAssetId: asset.id, processingRunId: run.id, version: 1, status: 'ACTIVE', language: 'en',
        pipelineVersion: 'g3-transcript-v1', modelVersion: 'fake-moss', durationMs: 30_000,
        cueCount: 1, publishedAt: new Date(),
        cues: { create: {
          order: 0, startMs: 500, endMs: 1_500, text: 'Owner only.',
          words: [{ text: 'Owner', startMs: 500, endMs: 900 }, { text: 'only.', startMs: 1_000, endMs: 1_500 }],
        } },
      },
    })
    const owned = await request(app.getHttpServer())
      .get(`/api/v1/media-assets/${asset.id}/transcript`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
    expect(owned.body).toMatchObject({ id: transcript.id, cueCount: 1, cues: [{ text: 'Owner only.' }] })
    await request(app.getHttpServer())
      .get(`/api/v1/media-assets/${asset.id}/transcript`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .expect(404)

    const failedAsset = await database.mediaAsset.create({
      data: { ownerId: owner.user.id, title: 'Retry transcript', originalName: 'retry.mp4', status: 'PLAYABLE', durationMs: 30_000 },
    })
    const failedRun = await database.processingRun.create({
      data: {
        ownerId: owner.user.id, mediaAssetId: failedAsset.id, pipelineVersion: 'g3-transcript-v1',
        status: 'FAILED', stage: 'TRANSCRIBING', errorCode: 'moss_timeout', failedAt: new Date(),
      },
    })
    const failedChunk = await database.processingChunk.create({
      data: {
        processingRunId: failedRun.id, chunkIndex: 0, startMs: 0, endMs: 30_000, status: 'FAILED',
        idempotencyKey: 'g3:' + 'b'.repeat(64), modelVersion: 'fake-moss', inputObjectKey: 'redacted.wav',
        errorCode: 'moss_timeout', failedAt: new Date(),
      },
    })
    await database.mediaObject.create({ data: {
      mediaAssetId: failedAsset.id, kind: 'AUDIO_CHUNK', bucket: 'test', objectKey: 'redacted.wav',
      contentType: 'audio/wav', sizeBytes: 1n, metadata: { processingRunId: failedRun.id, chunkIndex: 0 },
    } })
    const retry = () => request(app.getHttpServer())
      .post(`/api/v1/media-assets/${failedAsset.id}/transcript/retry`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', 'retry-owner-1234')
    await retry().expect(201, { accepted: true, processingRunId: failedRun.id, duplicate: false })
    await retry().expect(201, { accepted: true, processingRunId: failedRun.id, duplicate: true })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: failedRun.id } })).toMatchObject({ status: 'QUEUED', stage: 'TRANSCRIBING' })
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: failedChunk.id } })).toMatchObject({ status: 'QUEUED', errorCode: null })
    expect(await database.outboxEvent.count({ where: { eventType: 'media.transcript_retry_requested' } })).toBe(1)
    await request(app.getHttpServer())
      .post(`/api/v1/media-assets/${failedAsset.id}/transcript/retry`)
      .set('authorization', `Bearer ${other.accessToken}`)
      .set('idempotency-key', 'retry-other-1234')
      .expect(404)

    const cancel = () => request(app.getHttpServer())
      .post(`/api/v1/media-assets/${failedAsset.id}/transcript/cancel`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .set('idempotency-key', 'cancel-owner-1234')
    await cancel().expect(201, { cancelled: true, processingRunId: failedRun.id, duplicate: false })
    await cancel().expect(201, { cancelled: true, processingRunId: failedRun.id, duplicate: true })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: failedRun.id } })).toMatchObject({ status: 'CANCELLED', errorCode: 'processing_cancelled' })
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: failedChunk.id } })).toMatchObject({ status: 'CANCELLED', errorCode: 'processing_cancelled' })
    expect(await database.outboxEvent.count({ where: { eventType: 'media.transcript_cancel_requested' } })).toBe(1)
  })
})
