/**
 * AlignmentAdapter Port and deterministic in-memory Fake.
 *
 * The Port covers the internal operations required by the G3 v2 contract:
 * submit / query / read / cancel. Inputs carry ONLY non-content synthetic
 * metadata: opaque handles, digests and window bounds. The Fake never reads
 * real MFA, audio, models, object storage or network, and its fixtures hold
 * no private text/media, raw results, object keys/URLs, digests of private
 * content or secrets.
 */

import type { AlignmentJobStatus } from './types'

export interface AlignmentSubmitInput {
  idempotencyKey: string
  correlationHandle: string
  pipelineVersion: string
  windowStartMs: number
  windowEndMs: number
  methodDigest: string
  modelDigest: string
  configDigest: string
}

export interface AlignmentSubmission {
  correlationHandle: string
  externalJobId: string
}

export interface AlignmentStatusView {
  externalJobId: string
  state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  code: string | null
}

export interface AlignmentResultView {
  externalJobId: string
  decision: 'accepted' | 'insufficient'
  decisionCode: string
  candidateCount: number
  anchorCount: number
  coverageMs: number
}

export interface AlignmentAdapter {
  submit(input: AlignmentSubmitInput): Promise<AlignmentSubmission>
  /**
   * Read the provider-side reservation by its stable idempotency identity.
   *
   * This is deliberately metadata-only.  It lets the runtime adopt a job
   * that the provider accepted when the submit response was lost, instead of
   * issuing a second submission for the same handoff.
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<AlignmentSubmission | null>
  query(externalJobId: string): Promise<AlignmentStatusView>
  read(externalJobId: string): Promise<AlignmentResultView>
  cancel(externalJobId: string): Promise<void>
}

export const ALIGNMENT_ADAPTER_CODES = [
  'job_not_found',
  'job_not_terminal',
  'idempotency_collision',
  'invalid_submit_input',
  'duplicate_correlation_handle',
  'response_lost',
  'alignment_unavailable',
  'alignment_timeout',
  'alignment_rate_limited',
] as const
export type AlignmentAdapterCode = (typeof ALIGNMENT_ADAPTER_CODES)[number]

export class AlignmentAdapterError extends Error {
  constructor(
    readonly code: AlignmentAdapterCode,
    message: string,
  ) {
    super(message)
    this.name = 'AlignmentAdapterError'
  }
}

interface FakeJob {
  input: AlignmentSubmitInput
  externalJobId: string
  state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  result: AlignmentResultView | null
}

export type ScriptedOutcome =
  | { state: 'SUCCEEDED'; result: Omit<AlignmentResultView, 'externalJobId'> }
  | { state: 'FAILED'; result: Omit<AlignmentResultView, 'externalJobId'> }
  | { state: 'CANCELLED'; result: Omit<AlignmentResultView, 'externalJobId'> }
  | { state: 'PENDING' | 'RUNNING' }

/**
 * Deterministic in-memory Fake: outcomes are scripted per external job id
 * before/after submission; submit/query/read/cancel never touch I/O.
 */
export class InMemoryAlignmentAdapter implements AlignmentAdapter {
  private readonly jobsById = new Map<string, FakeJob>()
  private readonly jobsByCorrelation = new Map<string, FakeJob>()
  private readonly jobsByIdempotency = new Map<string, FakeJob>()
  private readonly outcomes = new Map<string, ScriptedOutcome>()
  private readonly queryErrors = new Map<string, AlignmentAdapterCode[]>()
  private readonly findErrors: AlignmentAdapterCode[] = []
  private readonly submitErrors: AlignmentAdapterCode[] = []
  private loseNextSubmitResponse = false
  private counter = 0
  private queries = 0

  scriptOutcome(externalJobId: string, outcome: ScriptedOutcome): void {
    this.outcomes.set(externalJobId, outcome)
  }

  submittedCount(): number {
    return this.jobsById.size
  }

  queryCount(): number {
    return this.queries
  }

  /** Cause exactly one submit to persist the job but lose its response. */
  scriptResponseLossOnce(): void {
    this.loseNextSubmitResponse = true
  }

  /** Cause the next status query for a job to fail with a retryable code. */
  scriptQueryErrorOnce(externalJobId: string, code: Extract<AlignmentAdapterCode, 'alignment_unavailable' | 'alignment_timeout' | 'alignment_rate_limited'>): void {
    const errors = this.queryErrors.get(externalJobId) ?? []
    errors.push(code)
    this.queryErrors.set(externalJobId, errors)
  }

  /** Cause one idempotency lookup to fail before any provider state is read. */
  scriptFindErrorOnce(code: Extract<AlignmentAdapterCode, 'alignment_unavailable' | 'alignment_timeout' | 'alignment_rate_limited'>): void {
    this.findErrors.push(code)
  }

  /** Cause one pre-acceptance submit attempt to fail without creating a job. */
  scriptSubmitErrorOnce(code: Extract<AlignmentAdapterCode, 'alignment_unavailable' | 'alignment_timeout' | 'alignment_rate_limited'>): void {
    this.submitErrors.push(code)
  }

  async submit(input: AlignmentSubmitInput): Promise<AlignmentSubmission> {
    const scriptedError = this.submitErrors.shift()
    if (scriptedError) throw new AlignmentAdapterError(scriptedError, 'scripted retryable alignment submit failure')
    if (!input.idempotencyKey || !input.correlationHandle || input.windowEndMs <= input.windowStartMs) {
      throw new AlignmentAdapterError('invalid_submit_input', 'submit input is missing required non-content metadata')
    }
    for (const job of this.jobsById.values()) {
      if (job.input.idempotencyKey === input.idempotencyKey) {
        throw new AlignmentAdapterError('idempotency_collision', 'a job with this idempotency identity already exists')
      }
    }
    if (this.jobsByCorrelation.has(input.correlationHandle)) {
      throw new AlignmentAdapterError('duplicate_correlation_handle', 'correlation handle already in use')
    }
    this.counter += 1
    const externalJobId = `fake-align-${this.counter}`
    const job: FakeJob = { input, externalJobId, state: 'PENDING', result: null }
    this.jobsById.set(externalJobId, job)
    this.jobsByCorrelation.set(input.correlationHandle, job)
    this.jobsByIdempotency.set(input.idempotencyKey, job)
    if (this.loseNextSubmitResponse) {
      this.loseNextSubmitResponse = false
      throw new AlignmentAdapterError('response_lost', 'provider accepted the submission but the response was lost')
    }
    return { correlationHandle: input.correlationHandle, externalJobId }
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<AlignmentSubmission | null> {
    const scriptedError = this.findErrors.shift()
    if (scriptedError) throw new AlignmentAdapterError(scriptedError, 'scripted retryable alignment lookup failure')
    const job = this.jobsByIdempotency.get(idempotencyKey)
    return job ? { correlationHandle: job.input.correlationHandle, externalJobId: job.externalJobId } : null
  }

  async query(externalJobId: string): Promise<AlignmentStatusView> {
    this.queries += 1
    const job = this.jobsById.get(externalJobId)
    if (!job) throw new AlignmentAdapterError('job_not_found', 'unknown external job id')
    const errors = this.queryErrors.get(externalJobId)
    const scriptedError = errors?.shift()
    if (scriptedError) throw new AlignmentAdapterError(scriptedError, 'scripted retryable alignment query failure')
    const outcome = this.outcomes.get(externalJobId)
    const state = outcome ? outcome.state : job.state
    return { externalJobId, state, code: outcome && 'result' in outcome ? outcome.result.decisionCode : null }
  }

  async read(externalJobId: string): Promise<AlignmentResultView> {
    const job = this.jobsById.get(externalJobId)
    if (!job) throw new AlignmentAdapterError('job_not_found', 'unknown external job id')
    const outcome = this.outcomes.get(externalJobId)
    if (!outcome || !('result' in outcome)) {
      throw new AlignmentAdapterError('job_not_terminal', 'job has no terminal result yet')
    }
    return { externalJobId, ...outcome.result }
  }

  async cancel(externalJobId: string): Promise<void> {
    const job = this.jobsById.get(externalJobId)
    if (!job) throw new AlignmentAdapterError('job_not_found', 'unknown external job id')
    job.state = 'CANCELLED'
    this.outcomes.set(externalJobId, {
      state: 'CANCELLED',
      result: { decision: 'insufficient', decisionCode: 'alignment_cancelled', candidateCount: 0, anchorCount: 0, coverageMs: 0 },
    })
  }
}

/** Type guard helper: keeps adapter-facing code free of alignment internals. */
export function assertAdapterStatus(status: AlignmentJobStatus): void {
  if (!['PENDING', 'SUBMITTED', 'POLLING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) {
    throw new AlignmentAdapterError('invalid_submit_input', `unknown alignment job status ${status}`)
  }
}
