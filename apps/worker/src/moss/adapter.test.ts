import { describe, expect, it, vi } from 'vitest'
import type { ServerEnv } from '@online-learning/config'
import { FakeMossAdapter } from './fake-adapter'
import { HttpMossAdapter } from './adapter'

const env = {
  MOSS_ENABLED: true,
  MOSS_BASE_URL: 'https://moss.example',
  MOSS_API_TOKEN: 'moss-token-long-enough',
  MOSS_REQUEST_TIMEOUT_MS: 50,
  MOSS_MAX_ATTEMPTS: 3,
} as ServerEnv

const input = {
  idempotencyKey: 'version:pipeline:transcribing:0:model',
  audioUrl: 'https://objects.example/chunk.wav?signature=private',
  callbackUrl: 'https://api.example/api/v1/integrations/moss/callback',
  language: 'en' as const,
  modelVersion: 'moss-v1', chunkIndex: 0, startMs: 0, endMs: 600_000,
}

describe('G3 MOSS adapter', () => {
  it('deduplicates Fake MOSS submissions by stable idempotency identity', async () => {
    const moss = new FakeMossAdapter()
    const first = await moss.submit(input)
    const second = await moss.submit(input)
    expect(second.externalJobId).toBe(first.externalJobId)
    expect(moss.submissions).toBe(1)
  })

  it('checks an existing job before POST and does not expose storage credentials', async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty('x-minio-secret')
      if (String(url).includes('by-idempotency-key')) return new Response(JSON.stringify({
        externalJobId: 'moss-existing', idempotencyKey: input.idempotencyKey, status: 'processing',
      }))
      throw new Error('POST must not execute')
    })
    const adapter = new HttpMossAdapter({ env, fetchImpl: fetcher, sleep: async () => undefined })
    await expect(adapter.submit(input)).resolves.toMatchObject({ externalJobId: 'moss-existing' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rechecks idempotency after a lost POST response before retrying', async () => {
    let lookup = 0
    let posts = 0
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('by-idempotency-key')) {
        lookup += 1
        return lookup === 1
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify({ externalJobId: 'moss-accepted', idempotencyKey: input.idempotencyKey, status: 'queued' }))
      }
      if (init?.method === 'POST') {
        posts += 1
        throw new TypeError('response lost')
      }
      throw new Error('unexpected request')
    })
    const adapter = new HttpMossAdapter({ env, fetchImpl: fetcher, sleep: async () => undefined })
    await expect(adapter.submit(input)).resolves.toMatchObject({ externalJobId: 'moss-accepted' })
    expect(posts).toBe(1)
  })

  it('classifies 429 as retryable and malformed results as terminal', async () => {
    const limited = new HttpMossAdapter({
      env: { ...env, MOSS_MAX_ATTEMPTS: 1 } as ServerEnv,
      fetchImpl: async () => new Response('{}', { status: 429 }), sleep: async () => undefined,
    })
    await expect(limited.query('job')).rejects.toMatchObject({ code: 'moss_rate_limited', retryable: true })

    const malformed = new HttpMossAdapter({
      env, fetchImpl: async () => new Response(JSON.stringify({ language: 'en', words: [{ text: 'hello' }] })),
      sleep: async () => undefined,
    })
    await expect(malformed.result('job')).rejects.toMatchObject({ code: 'moss_invalid_response', retryable: false })
  })
})
