import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MossClient } from './client'

const env = {
  MOSS_BASE_URL: 'http://moss:8001',
  MOSS_REQUEST_TIMEOUT_MS: 50,
  MOSS_MAX_RETRIES: 2,
  MOSS_RETRY_DELAY_MS: 1,
} as never

const media = {
  fileName: 'echoflow-job-1-lesson.mp4',
  contentType: 'video/mp4',
  openStream: async () => Readable.from([Buffer.from('video-bytes')]),
}
const input = { idempotencyKey: 'job-1:transcribe', jobId: 'job-1', uploadId: 'upload-1', type: 'transcribe', payload: {}, media }

describe('MossClient', () => {
  it('uploads multipart media with a stable idempotency key', async () => {
    let request: RequestInit | undefined
    const client = new MossClient({
      env,
      fetchImpl: async (_url, init) => {
        if (init?.method === 'GET') return new Response(JSON.stringify({ jobs: [] }), { status: 200 })
        request = init
        return new Response(JSON.stringify({ id: 'moss-1', status: 'queued' }), { status: 201 })
      },
      sleep: async () => undefined,
    })

    await expect(client.createJob(input)).resolves.toEqual({ jobId: 'moss-1', response: { id: 'moss-1', status: 'queued' } })
    expect(request?.headers).toMatchObject({ 'idempotency-key': 'job-1:transcribe' })
    expect((request?.headers as Record<string, string>)['content-type']).toContain('multipart/form-data; boundary=')
    const body = await new Response(request?.body as ReadableStream).text()
    expect(body).toContain('name="file"; filename="echoflow-job-1-lesson.mp4"')
    expect(body).toContain('video-bytes')
  })

  it('returns the existing MOSS job instead of uploading a duplicate', async () => {
    let openCalls = 0
    const client = new MossClient({
      env,
      fetchImpl: async () => new Response(JSON.stringify({ jobs: [{ id: 'moss-existing', status: 'queued', media_name: media.fileName }] }), { status: 200 }),
      sleep: async () => undefined,
    })
    const existingInput = { ...input, media: { ...media, openStream: async () => { openCalls += 1; return Readable.from([]) } } }

    await expect(client.createJob(existingInput)).resolves.toMatchObject({ jobId: 'moss-existing' })
    expect(openCalls).toBe(0)
  })

  it('retries transient HTTP errors and succeeds', async () => {
    let postCalls = 0
    const client = new MossClient({
      env,
      fetchImpl: async (_url, init) => {
        if (init?.method === 'GET') return new Response(JSON.stringify({ jobs: [] }), { status: 200 })
        postCalls += 1
        return postCalls < 3
          ? new Response('', { status: 503 })
          : new Response(JSON.stringify({ jobId: 'moss-2', status: 'queued' }), { status: 200 })
      },
      sleep: async () => undefined,
    })

    await expect(client.createJob(input)).resolves.toMatchObject({ jobId: 'moss-2' })
    expect(postCalls).toBe(3)
  })

  it('classifies connection failures after retries', async () => {
    const client = new MossClient({ env, fetchImpl: async () => { throw new Error('connect ECONNREFUSED') }, sleep: async () => undefined })
    await expect(client.createJob(input)).rejects.toMatchObject({ code: 'MOSS_UNAVAILABLE', retryable: true })
  })

  it('classifies request timeouts', async () => {
    const timeoutEnv = {
      MOSS_BASE_URL: 'http://moss:8001',
      MOSS_REQUEST_TIMEOUT_MS: 5,
      MOSS_MAX_RETRIES: 0,
      MOSS_RETRY_DELAY_MS: 1,
    } as never
    const client = new MossClient({
      env: timeoutEnv,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      sleep: async () => undefined,
    })
    await expect(client.createJob(input)).rejects.toMatchObject({ code: 'MOSS_TIMEOUT', retryable: true })
  })

  it('classifies malformed responses without retrying the POST', async () => {
    let postCalls = 0
    const client = new MossClient({
      env,
      fetchImpl: async (_url, init) => {
        if (init?.method === 'GET') return new Response(JSON.stringify({ jobs: [] }), { status: 200 })
        postCalls += 1
        return new Response('{}', { status: 200 })
      },
      sleep: async () => undefined,
    })

    await expect(client.createJob(input)).rejects.toMatchObject({ code: 'MOSS_INVALID_RESPONSE', retryable: false })
    expect(postCalls).toBe(1)
  })
})
