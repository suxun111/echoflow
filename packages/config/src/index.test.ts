import { describe, expect, it } from 'vitest'
import { loadServerEnv } from './index'

describe('server environment', () => {
  it('rejects unsafe production defaults', () => {
    expect(() => loadServerEnv({ NODE_ENV: 'production' })).toThrow()
  })

  it('provides development defaults outside production', () => {
    const env = loadServerEnv({ NODE_ENV: 'test' })
    expect(env.DATABASE_URL).toContain('postgresql://')
    expect(env.MEDIA_QUEUE_NAME).toBe('online-learning-media')
    expect(env.MOSS_BASE_URL).toBe('http://127.0.0.1:8001')
    expect(env.MOSS_MAX_RETRIES).toBe(2)
    expect(env.MOSS_POLL_INTERVAL_MS).toBe(5_000)
  })

  it('requires an explicit MOSS endpoint in production', () => {
    expect(() => loadServerEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://db',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: 'a'.repeat(40),
      MINIO_ACCESS_KEY: 'minio',
      MINIO_SECRET_KEY: 'secret',
      MINIO_BUCKET: 'bucket',
    })).toThrow(/MOSS_BASE_URL/)
  })

  it('rejects a loopback MOSS endpoint in production', () => {
    expect(() => loadServerEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://db',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: 'a'.repeat(40),
      MINIO_ACCESS_KEY: 'minio',
      MINIO_SECRET_KEY: 'secret',
      MINIO_BUCKET: 'bucket',
      MOSS_BASE_URL: 'http://127.0.0.1:8001',
    })).toThrow(/reachable service hostname/)
  })
})
