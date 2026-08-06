import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from './app.module'

describe('API skeleton', () => {
  let app: INestApplication
  const previousNodeEnv = process.env.NODE_ENV
  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    process.env.NODE_ENV = previousNodeEnv
  })
  it('reports health', async () => { const response = await request(app.getHttpServer()).get('/api/health').expect(200); expect(response.body.status).toBe('ok') })
  it('lists published videos', async () => { const response = await request(app.getHttpServer()).get('/api/videos?level=A2').expect(200); expect(response.body.total).toBeGreaterThan(0) })
  it('creates and verifies a development code', async () => {
    const requested = await request(app.getHttpServer()).post('/api/auth/request-code').send({ phone: '13800000000' }).expect(201)
    const session = await request(app.getHttpServer()).post('/api/auth/verify-code').send({ phone: '13800000000', code: requested.body.developmentCode }).expect(201)
    await request(app.getHttpServer()).get('/api/progress/lesson-1').expect(401)
    await request(app.getHttpServer()).put('/api/progress/lesson-1').set('Authorization', `Bearer ${session.body.accessToken}`).send({ completedCueIds: ['cue-1'], positionMs: 5000 }).expect(200)
    const progress = await request(app.getHttpServer()).get('/api/progress/lesson-1').set('Authorization', `Bearer ${session.body.accessToken}`).expect(200)
    expect(progress.body.completedCueIds).toEqual(['cue-1'])
    const upload = await request(app.getHttpServer()).post('/api/uploads/presign').set('Authorization', `Bearer ${session.body.accessToken}`).send({ fileName: 'lesson.mp4', contentType: 'video/mp4', sizeBytes: 1024, rightsConfirmed: true }).expect(201)
    const completed = await request(app.getHttpServer()).post(`/api/uploads/${upload.body.uploadId}/complete`).set('Authorization', `Bearer ${session.body.accessToken}`).expect(201)
    expect(completed.body.firstJob.id).toBe(upload.body.firstJob.id)
  })
})
