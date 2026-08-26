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
  private readonly outcomes = new Map<string, ScriptedOutcome>()
  private counter = 0

  scriptOutcome(externalJobId: string, outcome: ScriptedOutcome): void {
    this.outcomes.set(externalJobId, outcome)
  }

  submittedCount(): number {
    return this.jobsById.size
  }

  async submit(input: AlignmentSubmitInput): Promise<AlignmentSubmission> {
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
    return { correlationHandle: input.correlationHandle, externalJobId }
  }

  async query(externalJobId: string): Promise<AlignmentStatusView> {
    const job = this.jobsById.get(externalJobId)
    if (!job) throw new AlignmentAdapterError('job_not_found', 'unknown external job id')
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
