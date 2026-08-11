import { describe, expect, it, vi } from 'vitest'
import type { ServerEnv } from '@online-learning/config'
import { classifyMossRequestError, MOSS_ERROR_CODES, mossRequest, normalizeMossSegments, offsetCues } from './pipeline'

describe('MOSS subtitle normalization', () => {
  it('converts MOSS seconds, speakers, and text into ordered millisecond cues', () => {
    expect(normalizeMossSegments({ segments: [
      { start: 0.25, end: 1.75, speaker: 'S01', text: 'Hello there.' },
      { start: 2, end: 3.5, speaker: 'S02', text: 'Welcome back.' },
    ] })).toEqual([
      { order: 0, startMs: 250, endMs: 1750, speaker: 'S01', english: 'Hello there.' },
      { order: 1, startMs: 2000, endMs: 3500, speaker: 'S02', english: 'Welcome back.' },
    ])
  })

  it('drops malformed or empty source segments instead of writing invalid subtitle rows', () => {
    expect(normalizeMossSegments([{ start: 2, end: 1, text: 'bad' }, { start: 1, end: 2, text: '  ' }])).toEqual([])
  })

  it('restores chunk offsets before the combined cues are stored', () => {
    expect(offsetCues([{ order: 0, startMs: 250, endMs: 1750, speaker: 'S01', english: 'Chunked cue.' }], 45000)).toEqual([
      { order: 0, startMs: 45250, endMs: 46750, speaker: 'S01', english: 'Chunked cue.' },
    ])
  })

  it('classifies a network failure with an actionable stable code', () => {
    const error = classifyMossRequestError(new TypeError('fetch failed'))
    expect(error.code).toBe(MOSS_ERROR_CODES.UNAVAILABLE)
    expect(error.retryable).toBe(true)
    expect(error.message).not.toBe('fetch failed')
  })

  it('classifies an aborted request as a retryable timeout', () => {
    const source = new Error('request aborted')
    source.name = 'TimeoutError'
    const error = classifyMossRequestError(source)
    expect(error.code).toBe(MOSS_ERROR_CODES.TIMEOUT)
    expect(error.retryable).toBe(true)
  })

  it('retries a transient MOSS 503 response with exponential backoff', async () => {
    const mockFetcher = vi.fn()
    mockFetcher
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ detail: 'busy' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const env = { MOSS_REQUEST_TIMEOUT_MS: 1000, MOSS_MAX_RETRIES: 1, MOSS_RETRY_DELAY_MS: 1 } as ServerEnv

    await expect(mossRequest('http://moss/api/health', {}, env, mockFetcher as typeof fetch)).resolves.toEqual({ ok: true })
    expect(mockFetcher).toHaveBeenCalledTimes(2)
  })
})
