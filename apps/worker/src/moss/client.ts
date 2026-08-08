import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { loadServerEnv, type ServerEnv } from '@online-learning/config'

export type MossErrorCode = 'MOSS_UNAVAILABLE' | 'MOSS_TIMEOUT' | 'MOSS_HTTP_ERROR' | 'MOSS_INVALID_RESPONSE' | 'MOSS_JOB_FAILED'

export class MossError extends Error {
  readonly name = 'MossError'

  constructor(
    readonly code: MossErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message)
  }
}

export type MossCreateJobInput = {
  idempotencyKey: string
  jobId: string
  uploadId: string
  type: string
  payload: Record<string, unknown>
  media: MossMediaInput
}

export type MossMediaInput = {
  fileName: string
  contentType: string
  // A new stream is opened for every HTTP attempt so a transient MOSS error
  // never causes a retry to reuse an already-consumed upload stream.
  openStream: () => Promise<NodeJS.ReadableStream>
}

export type MossCreateJobResult = {
  jobId: string
  response: Record<string, unknown>
}

export type MossJob = MossCreateJobResult & {
  status: string
  progress: number | null
  error: string | null
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

type MossClientOptions = {
  env?: ServerEnv
  fetchImpl?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
}

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseJobId(response: Record<string, unknown>) {
  const direct = response.jobId ?? response.job_id ?? response.id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const data = response.data
  if (isRecord(data)) {
    const nested = data.jobId ?? data.job_id ?? data.id
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

function responseStatus(response: Record<string, unknown>) {
  return typeof response.status === 'string' && response.status.length > 0 ? response.status : null
}

function responseProgress(response: Record<string, unknown>) {
  return typeof response.progress === 'number' && Number.isFinite(response.progress) ? response.progress : null
}

function responseError(response: Record<string, unknown>) {
  return typeof response.error === 'string' && response.error.length > 0 ? response.error : null
}

function toMossJob(response: Record<string, unknown>): MossJob {
  const jobId = responseJobId(response)
  const status = responseStatus(response)
  if (!jobId || !status) throw new MossError('MOSS_INVALID_RESPONSE', 'MOSS returned an invalid job response', false)
  return { jobId, status, progress: responseProgress(response), error: responseError(response), response }
}

function formValue(value: string) {
  return value.replace(/[\r\n"]/g, '_')
}

function createMultipartBody(input: MossCreateJobInput) {
  const boundary = `----echoflow-moss-${randomUUID()}`
  const fileName = formValue(input.media.fileName)
  const contentType = input.media.contentType || 'application/octet-stream'

  async function* parts() {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`)
    const source = await input.media.openStream()
    for await (const chunk of source) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    yield Buffer.from(`\r\n--${boundary}--\r\n`)
  }

  return {
    body: Readable.toWeb(Readable.from(parts())) as unknown as ReadableStream,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

export class MossClient {
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(options: MossClientOptions = {}) {
    const env = options.env ?? loadServerEnv()
    this.baseUrl = env.MOSS_BASE_URL.replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? defaultSleep
    this.timeoutMs = env.MOSS_REQUEST_TIMEOUT_MS
    this.maxRetries = env.MOSS_MAX_RETRIES
    this.retryDelayMs = env.MOSS_RETRY_DELAY_MS
    this.apiToken = env.MOSS_API_TOKEN
  }

  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly apiToken?: string

  private headers() {
    const headers: Record<string, string> = {}
    if (this.apiToken) headers.authorization = `Bearer ${this.apiToken}`
    return headers
  }

  private async requestJson(path: string, initFactory: (signal: AbortSignal) => Promise<RequestInit> | RequestInit): Promise<Record<string, unknown>> {
    const url = new URL(path, `${this.baseUrl}/`).toString()
    let lastError: MossError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(url, await initFactory(controller.signal))
        if (!response.ok) {
          const error = new MossError('MOSS_HTTP_ERROR', `MOSS returned HTTP ${response.status}`, retryableStatuses.has(response.status), response.status)
          if (!error.retryable || attempt === this.maxRetries) throw error
          lastError = error
        } else {
          let parsed: unknown
          try {
            parsed = await response.json()
          } catch {
            throw new MossError('MOSS_INVALID_RESPONSE', 'MOSS returned invalid JSON', false)
          }
          if (!isRecord(parsed)) throw new MossError('MOSS_INVALID_RESPONSE', 'MOSS returned an invalid JSON response', false)
          return parsed
        }
      } catch (error) {
        const normalized = error instanceof MossError
          ? error
          : controller.signal.aborted
            ? new MossError('MOSS_TIMEOUT', `MOSS request timed out after ${this.timeoutMs}ms`, true)
            : new MossError('MOSS_UNAVAILABLE', 'MOSS service is unavailable', true)
        if (!normalized.retryable || attempt === this.maxRetries) throw normalized
        lastError = normalized
      } finally {
        clearTimeout(timer)
      }
      await this.sleep(this.retryDelayMs * (2 ** attempt))
    }
    throw lastError ?? new MossError('MOSS_UNAVAILABLE', 'MOSS service is unavailable', true)
  }

  async findJobByMediaName(mediaName: string): Promise<MossJob | null> {
    const response = await this.requestJson('/api/jobs', (signal) => ({ method: 'GET', headers: this.headers(), signal }))
    if (!Array.isArray(response.jobs)) throw new MossError('MOSS_INVALID_RESPONSE', 'MOSS returned an invalid job list', false)
    for (const item of response.jobs) {
      if (!isRecord(item) || item.media_name !== mediaName) continue
      return toMossJob(item)
    }
    return null
  }

  async createJob(input: MossCreateJobInput): Promise<MossCreateJobResult> {
    // Upstream MOSS does not currently persist an Idempotency-Key header. A
    // stable, job-scoped file name lets us discover an accepted job after a
    // worker restart or a lost POST response instead of creating a duplicate.
    const existing = await this.findJobByMediaName(input.media.fileName)
    if (existing) return { jobId: existing.jobId, response: existing.response }

    const response = await this.requestJson('/api/jobs', async (signal) => {
      const multipart = createMultipartBody(input)
      return {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': multipart.contentType, 'idempotency-key': input.idempotencyKey },
        body: multipart.body,
        signal,
        // Node's fetch requires this flag for streaming request bodies.
        duplex: 'half',
      } as RequestInit
    })
    const job = toMossJob(response)
    return { jobId: job.jobId, response: job.response }
  }

  async getJob(jobId: string): Promise<MossJob> {
    const response = await this.requestJson(`/api/jobs/${encodeURIComponent(jobId)}`, (signal) => ({ method: 'GET', headers: this.headers(), signal }))
    return toMossJob(response)
  }

  async checkReadiness(): Promise<'ok' | 'failed'> {
    try {
      await this.requestJson('/api/runtime', (signal) => ({ method: 'GET', headers: this.headers(), signal }))
      return 'ok'
    } catch {
      return 'failed'
    }
  }
}
