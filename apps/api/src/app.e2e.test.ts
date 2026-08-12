import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { UserRole } from '@online-learning/database'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApplication } from './bootstrap'
import type { RequestLog } from './common/request-context'
import { DatabaseService } from './database/database.module'
import { createTestEnv } from './test/test-env'

const env = createTestEnv()

type LoginResult = {
  accessToken: string
  cookie: string
  rawCookie: string
  developmentCode: string
  user: { id: string; phone: string; role: string }
}

describe('G1 real PostgreSQL auth and owner boundary', () => {
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
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "ProcessingChunk", "ProcessingRun",
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

  beforeAll(startApp)
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

    const firstTranscript = await database.transcriptVersion.create({
      data: { mediaAssetId: firstAsset.id, version: 1, durationMs: 1_000 },
    })
    const secondTranscript = await database.transcriptVersion.create({
      data: { mediaAssetId: secondAsset.id, version: 1, durationMs: 1_000 },
    })
    await database.transcriptVersion.update({ where: { id: firstTranscript.id }, data: { status: 'ACTIVE' } })
    await expect(database.transcriptVersion.create({
      data: { mediaAssetId: firstAsset.id, version: 2, durationMs: 1_000, status: 'ACTIVE' },
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
})
