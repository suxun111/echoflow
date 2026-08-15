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

  it('reopens only a terminal failed job while preserving its stable identity', async () => {
    const moss = new FakeMossAdapter()
    const first = await moss.submit(input)
    moss.fail(first.externalJobId, 'temporary_failure')
    const retried = await moss.submit(input)
    expect(retried).toMatchObject({ externalJobId: first.externalJobId, status: 'queued', errorCode: null })
    expect(moss.submissions).toBe(2)
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

  it('maps a terminal provider job to a stable-identity retry request', async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('by-idempotency-key')) return new Response(JSON.stringify({
        externalJobId: 'moss-terminal', idempotencyKey: input.idempotencyKey, status: 'failed', errorCode: 'temporary',
      }))
      expect(String(url)).toContain('/api/provider/v1/jobs/moss-terminal/retry')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({
        externalJobId: 'moss-terminal', idempotencyKey: input.idempotencyKey, status: 'queued', errorCode: null,
      }))
    })
    const adapter = new HttpMossAdapter({ env, fetchImpl: fetcher, sleep: async () => undefined })
    await expect(adapter.submit(input)).resolves.toMatchObject({ externalJobId: 'moss-terminal', status: 'queued' })
    expect(fetcher).toHaveBeenCalledTimes(2)
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

  it('accepts provider-native English segment timings without inventing words', async () => {
    const adapter = new HttpMossAdapter({
      env, fetchImpl: async () => new Response(JSON.stringify({
        language: 'en', segments: [{ text: 'Hello from MOSS.', startMs: 250, endMs: 1_750, speaker: 'S01' }],
      })), sleep: async () => undefined,
    })
    await expect(adapter.result('job')).resolves.toEqual({
      language: 'en', segments: [{ text: 'Hello from MOSS.', startMs: 250, endMs: 1_750, speaker: 'S01' }],
    })
  })

  it('rejects an English result with neither word nor segment timings', async () => {
    const adapter = new HttpMossAdapter({
      env, fetchImpl: async () => new Response(JSON.stringify({ language: 'en', segments: [] })),
      sleep: async () => undefined,
    })
    await expect(adapter.result('job')).rejects.toMatchObject({ code: 'moss_invalid_response', retryable: false })
  })
})
