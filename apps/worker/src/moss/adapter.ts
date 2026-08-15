import type { ServerEnv } from '@online-learning/config'

export type MossJobState = 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled'

export type MossSubmitInput = {
  idempotencyKey: string
  audioUrl: string
  callbackUrl: string
  language: 'en'
  modelVersion: string
  chunkIndex: number
  startMs: number
  endMs: number
}

export type MossJob = {
  externalJobId: string
  idempotencyKey: string
  status: MossJobState
  errorCode: string | null
}

export type MossWord = { text: string; startMs: number; endMs: number }
export type MossSegment = { text: string; startMs: number; endMs: number; speaker?: string }
export type MossResult = { language: 'en'; segments?: MossSegment[]; words?: MossWord[] }

export interface MossAdapter {
  findByIdempotencyKey(idempotencyKey: string): Promise<MossJob | null>
  submit(input: MossSubmitInput): Promise<MossJob>
  query(externalJobId: string): Promise<MossJob>
  result(externalJobId: string): Promise<MossResult>
  cancel(externalJobId: string): Promise<void>
}

export type MossErrorCode =
  | 'moss_unavailable'
  | 'moss_timeout'
  | 'moss_rate_limited'
  | 'moss_rejected'
  | 'moss_invalid_response'

export class MossError extends Error {
  constructor(
    readonly code: MossErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'MossError'
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type HttpMossAdapterOptions = {
  env: ServerEnv
  fetchImpl?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
  random?: () => number
}

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJob(value: unknown): MossJob {
  if (!isRecord(value)) throw new MossError('moss_invalid_response', 'MOSS returned an invalid job', false)
  const externalJobId = value.externalJobId ?? value.jobId ?? value.id
  const idempotencyKey = value.idempotencyKey
  const status = value.status
  const errorCode = typeof value.errorCode === 'string' ? value.errorCode : null
  if (typeof externalJobId !== 'string' || typeof idempotencyKey !== 'string'
    || !['queued', 'processing', 'succeeded', 'failed', 'cancelled'].includes(String(status))) {
    throw new MossError('moss_invalid_response', 'MOSS returned an invalid job', false)
  }
  return { externalJobId, idempotencyKey, status: status as MossJobState, errorCode }
}

function parseResult(value: unknown): MossResult {
  if (!isRecord(value) || value.language !== 'en') {
    throw new MossError('moss_invalid_response', 'MOSS result must contain an English transcript', false)
  }
  if (value.words !== undefined && !Array.isArray(value.words)) {
    throw new MossError('moss_invalid_response', 'MOSS words must be an array', false)
  }
  if (value.segments !== undefined && !Array.isArray(value.segments)) {
    throw new MossError('moss_invalid_response', 'MOSS segments must be an array', false)
  }
  const words = (value.words ?? []).map((item) => {
    if (!isRecord(item) || typeof item.text !== 'string' || !Number.isInteger(item.startMs) || !Number.isInteger(item.endMs)) {
      throw new MossError('moss_invalid_response', 'MOSS returned an invalid word timing', false)
    }
    return { text: item.text.trim(), startMs: item.startMs as number, endMs: item.endMs as number }
  })
  const segments = (value.segments ?? []).map((item) => {
    if (!isRecord(item) || typeof item.text !== 'string' || !Number.isInteger(item.startMs) || !Number.isInteger(item.endMs)
      || (item.speaker !== undefined && typeof item.speaker !== 'string')) {
      throw new MossError('moss_invalid_response', 'MOSS returned an invalid segment timing', false)
    }
    return {
      text: item.text.trim(), startMs: item.startMs as number, endMs: item.endMs as number,
      ...(typeof item.speaker === 'string' && item.speaker.trim() ? { speaker: item.speaker.trim() } : {}),
    }
  })
  if (words.length === 0 && segments.length === 0) {
    throw new MossError('moss_invalid_response', 'MOSS result must contain word or segment timings', false)
  }
  return {
    language: 'en',
    ...(segments.length ? { segments } : {}),
    ...(words.length ? { words } : {}),
  }
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

export class HttpMossAdapter implements MossAdapter {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly random: () => number

  constructor(private readonly options: HttpMossAdapterOptions) {
    if (!options.env.MOSS_ENABLED || !options.env.MOSS_BASE_URL || !options.env.MOSS_API_TOKEN) {
      throw new MossError('moss_rejected', 'MOSS is not configured', false)
    }
    this.baseUrl = options.env.MOSS_BASE_URL.replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
  }

  private headers(body = false) {
    return {
      authorization: `Bearer ${this.options.env.MOSS_API_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    }
  }

  private normalizeError(error: unknown, controller: AbortController) {
    if (error instanceof MossError) return error
    if (controller.signal.aborted) return new MossError('moss_timeout', 'MOSS request timed out', true)
    return new MossError('moss_unavailable', 'MOSS service is unavailable', true)
  }

  private async requestOnce(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.env.MOSS_REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal })
      if (!response.ok) {
        const retryable = retryableStatuses.has(response.status)
        const code = response.status === 429 ? 'moss_rate_limited' : retryable ? 'moss_unavailable' : 'moss_rejected'
        throw new MossError(code, `MOSS returned HTTP ${response.status}`, retryable, response.status)
      }
      try {
        return await response.json()
      } catch {
        throw new MossError('moss_invalid_response', 'MOSS returned invalid JSON', false)
      }
    } catch (error) {
      throw this.normalizeError(error, controller)
    } finally {
      clearTimeout(timer)
    }
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: MossError | undefined
    for (let attempt = 0; attempt < this.options.env.MOSS_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        const normalized = error instanceof MossError ? error : new MossError('moss_unavailable', 'MOSS service is unavailable', true)
        if (!normalized.retryable || attempt + 1 === this.options.env.MOSS_MAX_ATTEMPTS) throw normalized
        lastError = normalized
        const base = Math.min(30_000, 500 * (2 ** attempt))
        await this.sleep(Math.round(base * (0.75 + this.random() * 0.5)))
      }
    }
    throw lastError ?? new MossError('moss_unavailable', 'MOSS service is unavailable', true)
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<MossJob | null> {
    try {
      const value = await this.requestOnce(`/api/provider/v1/jobs/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`, {
        method: 'GET', headers: this.headers(),
      })
      return parseJob(value)
    } catch (error) {
      if (error instanceof MossError && error.statusCode === 404) return null
      throw error
    }
  }

  async submit(input: MossSubmitInput) {
    return this.retry(async () => {
      const existing = await this.findByIdempotencyKey(input.idempotencyKey)
      if (existing && !['failed', 'cancelled'].includes(existing.status)) return existing
      const path = existing
        ? `/api/provider/v1/jobs/${encodeURIComponent(existing.externalJobId)}/retry`
        : '/api/provider/v1/jobs'
      const value = await this.requestOnce(path, {
        method: 'POST', headers: this.headers(true), body: JSON.stringify(input),
      })
      const job = parseJob(value)
      if (job.idempotencyKey !== input.idempotencyKey) {
        throw new MossError('moss_invalid_response', 'MOSS changed the idempotency identity', false)
      }
      return job
    })
  }

  query(externalJobId: string) {
    return this.retry(async () => parseJob(await this.requestOnce(`/api/provider/v1/jobs/${encodeURIComponent(externalJobId)}`, {
      method: 'GET', headers: this.headers(),
    })))
  }

  result(externalJobId: string) {
    return this.retry(async () => parseResult(await this.requestOnce(`/api/provider/v1/jobs/${encodeURIComponent(externalJobId)}/result`, {
      method: 'GET', headers: this.headers(),
    })))
  }

  async cancel(externalJobId: string) {
    await this.retry(async () => {
      await this.requestOnce(`/api/provider/v1/jobs/${encodeURIComponent(externalJobId)}/cancel`, {
        method: 'POST', headers: this.headers(true), body: '{}',
      })
    })
  }
}
