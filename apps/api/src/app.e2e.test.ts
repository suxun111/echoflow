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
    await request(app.getHttpServer()).post('/api/auth/verify-code').send({ phone: '13800000000', code: requested.body.developmentCode }).expect(201)
  })
  it('registers a new phone on first successful verification', async () => {
    const requested = await request(app.getHttpServer()).post('/api/auth/request-code').send({ phone: '13900001111' }).expect(201)
    const verified = await request(app.getHttpServer()).post('/api/auth/verify-code').send({ phone: '13900001111', code: requested.body.developmentCode }).expect(201)

    expect(verified.body.user).toMatchObject({ phone: '13900001111', displayName: '用户1111' })
    expect(verified.body.user.id).not.toBe('user-13900001111')
  })
  it('rejects an incorrect verification code', async () => {
    await request(app.getHttpServer()).post('/api/auth/request-code').send({ phone: '13900002222' }).expect(201)

    await request(app.getHttpServer()).post('/api/auth/verify-code').send({ phone: '13900002222', code: '000000' }).expect(400)
  })
  it('allows development codes when the dev script inherits a production shell', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousLifecycleEvent = process.env.npm_lifecycle_event
    process.env.NODE_ENV = 'production'
    process.env.npm_lifecycle_event = 'dev'

    try {
      const response = await request(app.getHttpServer()).post('/api/auth/request-code').send({ phone: '13900004444' }).expect(201)
      expect(response.body.developmentCode).toBe('246810')
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      process.env.npm_lifecycle_event = previousLifecycleEvent
    }
  })
  it('returns the current user from a verified session token', async () => {
    const requested = await request(app.getHttpServer()).post('/api/auth/request-code').send({ phone: '13900003333' }).expect(201)
    const verified = await request(app.getHttpServer()).post('/api/auth/verify-code').send({ phone: '13900003333', code: requested.body.developmentCode }).expect(201)

    const response = await request(app.getHttpServer()).get('/api/users/me').set('Authorization', `Bearer ${verified.body.accessToken}`).expect(200)

    expect(response.body).toMatchObject({ id: verified.body.user.id, phone: '13900003333', displayName: '用户3333' })
  })
})
