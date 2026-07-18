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
})
