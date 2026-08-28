/**
 * Isolated F2 runtime for the v2 HANDOFF_EVIDENCING stage.
 *
 * This module deliberately owns only the metadata state machine:
 * PostgreSQL rows + injected deterministic Fakes.  It does not import the
 * transcript processor, storage, FFmpeg, MOSS, Redis, Outbox, API, or any
 * network client. F2 also deliberately excludes object identity from the
 * Fake path: no object key, version or content digest is read or persisted.
 * An accepted Fake alignment therefore fails closed, because the F1 schema
 * correctly requires an authorized ALIGNMENT_RAW identity before it can be
 * recorded as final evidence.
 */

import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@online-learning/database'
import { AlignmentAdapterError, type AlignmentAdapter, type AlignmentSubmission } from './alignment'
import {
  type HandoffChunkView,
  type MaterializedEvidence,
  type StrictAssessmentInputProvider,
  resolveAlignmentHandoff,
  resolveStrictHandoff,
} from './evidencing'
import type { ProofDigestService } from './proof'
import { MAX_ALIGNMENT_ATTEMPTS, PIPELINE_VERSION_V2 } from './types'
import {
  buildAlignmentIdempotencyKey,
  createCorrelationHandle,
  type ExpectedEvidenceIdentity,
  validateHandoffPair,
  validateStrictSegment,
} from './validators'

const DEFAULT_LEASE_MS = 60_000
const POLL_DELAY_MS = 1_000
const RETRY_DELAY_MS = 1_000
const RETRYABLE_ALIGNMENT_CODES = new Set(['alignment_unavailable', 'alignment_timeout', 'alignment_rate_limited'])
type RuntimeDatabase = PrismaClient | Prisma.TransactionClient

export interface V2HandoffRuntimeOptions {
  database: PrismaClient
  alignment: AlignmentAdapter
  assessment: StrictAssessmentInputProvider
  proof: ProofDigestService
  /** Non-content, 64-character identity digests supplied by the caller. */
  methodDigest: string
  modelDigest: string
  configDigest: string
  workerId: string
  now?: () => Date
  leaseMs?: number
}

export interface V2HandoffRuntimeInput {
  processingRunId: string
  mediaAssetId: string
}

export type V2HandoffRuntimeResult =
  | { kind: 'advanced'; handoffCount: number }
  | { kind: 'waiting'; handoffCount: number }
  | { kind: 'failed'; errorCode: 'transcript_incomplete' }
  | { kind: 'skipped'; handoffCount: 0 }

export interface V2HandoffCancellationResult {
  kind: 'cancelled' | 'skipped'
  cancelled: number
}

export class V2HandoffRuntimeError extends Error {
  constructor(readonly code: 'handoff_lease_lost', message: string) {
    super(message)
    this.name = 'V2HandoffRuntimeError'
  }
}

type EvidencingChunk = {
  id: string
  processingRunId: string
  planRevision: number
  chunkIndex: number
  status: string
  startMs: number
  endMs: number
}

type AssessmentRecord = {
  decision: string
  decisionCode: string
  evidenceType: string
  inputChecksum: string
  windowStartMs: number
  windowEndMs: number
}

/**
 * Run exactly one isolated v2 HANDOFF_EVIDENCING pass.
 *
 * Only all accepted handoffs advance to MERGING.  Any ambiguous or rejected
 * decision fails the run closed as transcript_incomplete; pending alignment
 * releases the lease and returns waiting.
 */
export async function advanceV2HandoffEvidencing(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
): Promise<V2HandoffRuntimeResult> {
  const now = options.now ?? (() => new Date())
  const leaseOwner = `${options.workerId}:${randomUUID()}`
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const claimedAt = now()

  const claimed = await options.database.processingRun.updateMany({
    where: {
      id: input.processingRunId,
      mediaAssetId: input.mediaAssetId,
      pipelineVersion: PIPELINE_VERSION_V2,
      stage: 'HANDOFF_EVIDENCING',
      status: { in: ['QUEUED', 'PROCESSING'] },
      OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: claimedAt } }],
    },
    data: {
      status: 'PROCESSING',
      startedAt: claimedAt,
      leaseOwner,
      leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
    },
  })
  if (claimed.count !== 1) return { kind: 'skipped', handoffCount: 0 }

  const run = await options.database.processingRun.findUniqueOrThrow({
    where: { id: input.processingRunId },
    select: { id: true, activePlanRevision: true, pendingPlanRevision: true },
  })
  const planRevision = run.pendingPlanRevision ?? run.activePlanRevision
  const chunks = await currentEffectivePlan(options.database, run.id, planRevision)

  if (chunks.length <= 1) {
    await advanceToMerging(options, input, leaseOwner, now)
    return { kind: 'advanced', handoffCount: 0 }
  }

  let waiting = false
  for (let logicalHandoffIndex = 0; logicalHandoffIndex < chunks.length - 1; logicalHandoffIndex += 1) {
    const previous = chunks[logicalHandoffIndex]!
    const next = chunks[logicalHandoffIndex + 1]!
    const result = await resolveHandoff(
      options,
      input,
      leaseOwner,
      now,
      planRevision,
      logicalHandoffIndex,
      previous,
      next,
    )
    if (result === 'failed') return { kind: 'failed', errorCode: 'transcript_incomplete' }
    if (result === 'waiting') waiting = true
  }

  if (waiting) {
    await releaseLease(options, input, leaseOwner, now)
    return { kind: 'waiting', handoffCount: chunks.length - 1 }
  }

  await advanceToMerging(options, input, leaseOwner, now)
  return { kind: 'advanced', handoffCount: chunks.length - 1 }
}

/**
 * Apply a cancellation fence for the isolated runtime.  It is intentionally
 * best-effort at the Fake adapter boundary, but fail-closed in PostgreSQL:
 * cancelled handoffs can never be advanced by a late adapter result.
 */
export async function cancelV2HandoffEvidencing(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
): Promise<V2HandoffCancellationResult> {
  const now = options.now ?? (() => new Date())
  const run = await options.database.processingRun.findFirst({
    where: {
      id: input.processingRunId,
      mediaAssetId: input.mediaAssetId,
      pipelineVersion: PIPELINE_VERSION_V2,
      status: 'CANCELLED',
    },
    select: { id: true },
  })
  if (!run) return { kind: 'skipped', cancelled: 0 }

  const jobs = await options.database.alignmentJob.findMany({
    where: {
      handoff: { processingRunId: run.id },
      // The API applies the local cancellation fence first.  Include those
      // already-cancelled rows so the test-only adapter can still receive an
      // idempotent cancellation and persist externalCancelledAt for recovery.
      status: { in: ['PENDING', 'SUBMITTED', 'POLLING', 'CANCELLED'] },
    },
    select: { id: true, handoffId: true, idempotencyKey: true, correlationHandle: true, externalJobId: true },
  })

  for (const job of jobs) {
    let submission: AlignmentSubmission | null = null
    let externalCancellationConfirmed = false
    if (job.externalJobId) {
      submission = { externalJobId: job.externalJobId, correlationHandle: job.correlationHandle }
    } else {
      try {
        submission = await options.alignment.findByIdempotencyKey(job.idempotencyKey)
      } catch {
        submission = null
      }
    }

    if (submission?.correlationHandle === job.correlationHandle) {
      if (!job.externalJobId) {
        await options.database.alignmentJob.updateMany({
          where: { id: job.id, externalJobId: null },
          data: { externalJobId: submission.externalJobId, submittedAt: now() },
        })
      }
      try {
        await options.alignment.cancel(submission.externalJobId)
        externalCancellationConfirmed = true
      } catch {
        // The run is already terminal.  Persist the local cancellation fence
        // below even if the remote Fake reports an already-gone job.
      }
    }

    await options.database.$transaction(async (transaction) => {
      await transaction.alignmentJob.updateMany({
        where: { id: job.id, status: { in: ['PENDING', 'SUBMITTED', 'POLLING', 'CANCELLED'] } },
        data: {
          status: 'CANCELLED', cancelledAt: now(), nextPollAt: null, nextAttemptAt: null,
          ...(externalCancellationConfirmed ? { externalCancelledAt: now() } : {}),
        },
      })
      await transaction.processingHandoff.updateMany({
        where: { id: job.handoffId, status: { in: ['PENDING', 'ASSESSING', 'ALIGNING'] } },
        data: { status: 'CANCELLED', cancelledAt: now(), leaseOwner: null, leaseExpiresAt: null },
      })
    })
  }

  const remaining = await options.database.processingHandoff.updateMany({
    where: {
      processingRunId: run.id,
      status: { in: ['PENDING', 'ASSESSING', 'ALIGNING'] },
    },
    data: { status: 'CANCELLED', cancelledAt: now(), leaseOwner: null, leaseExpiresAt: null },
  })
  return { kind: 'cancelled', cancelled: jobs.length + remaining.count }
}

async function resolveHandoff(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
  planRevision: number,
  logicalHandoffIndex: number,
  previous: EvidencingChunk,
  next: EvidencingChunk,
): Promise<'accepted' | 'waiting' | 'failed'> {
  try {
    validateHandoffPair(previous, next, planRevision)
  } catch {
    await failHandoff(options, input, leaseOwner, now, null, 'alignment_result_invalid')
    return 'failed'
  }

  const record = await ensureHandoffRecord(
    options.database,
    input.processingRunId,
    planRevision,
    logicalHandoffIndex,
    previous,
    next,
  )
  if (record.status === 'EVIDENCED') return 'accepted'
  if (record.status === 'FAILED' || record.status === 'CANCELLED') return 'failed'

  const strictInput = options.assessment.build(toHandoffChunkView(previous), toHandoffChunkView(next), planRevision)
  const strict = validateStrictSegment(strictInput)
  const assessment: AssessmentRecord = {
    decision: strict.decision,
    decisionCode: strict.decisionCode,
    evidenceType: strict.evidenceType,
    inputChecksum: strictInput.inputChecksum,
    windowStartMs: strict.windowStartMs,
    windowEndMs: strict.windowEndMs,
  }
  await ensureAssessment(options.database, record.id, assessment)

  const expected = buildExpectedIdentity(
    input.processingRunId,
    record,
    previous,
    next,
    strict.windowStartMs,
    strict.windowEndMs,
    options,
  )
  const strictResolution = resolveStrictHandoff(expected, strict, options.proof)
  if (strictResolution.kind === 'accepted') {
    await materializeEvidence(options, input, leaseOwner, now, record.id, strictResolution.evidence)
    return 'accepted'
  }
  if (strictResolution.kind === 'rejected') {
    await failHandoff(options, input, leaseOwner, now, record.id, strictResolution.decisionCode)
    return 'failed'
  }

  return resolveAlignment(
    options,
    input,
    leaseOwner,
    now,
    record,
    expected,
    assessment,
  )
}

async function resolveAlignment(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
  record: { id: string; planRevision: number; logicalHandoffIndex: number },
  expected: ExpectedEvidenceIdentity,
  assessment: AssessmentRecord,
): Promise<'accepted' | 'waiting' | 'failed'> {
  let job = await ensureAlignmentJob(options, record, expected)
  if (job.nextAttemptAt && job.nextAttemptAt > now()) return 'waiting'
  if (job.nextPollAt && job.nextPollAt > now()) return 'waiting'
  const adoption = await adoptOrSubmit(options, job)
  if (adoption.kind === 'retry') {
    return retryAlignmentOperation(options, input, leaseOwner, now, record.id, job, adoption.error)
  }
  const submission = adoption.submission
  if (submission.correlationHandle !== job.correlationHandle) {
    await failHandoff(options, input, leaseOwner, now, record.id, 'alignment_input_mismatch')
    return 'failed'
  }

  if (!job.externalJobId) {
    await options.database.alignmentJob.updateMany({
      where: { id: job.id, externalJobId: null },
      data: { externalJobId: submission.externalJobId, status: 'SUBMITTED', submittedAt: now(), nextAttemptAt: null },
    })
    job = await options.database.alignmentJob.findUniqueOrThrow({ where: { id: job.id } })
  }

  let status
  try {
    status = await options.alignment.query(job.externalJobId!)
  } catch (error) {
    return retryAlignmentOperation(options, input, leaseOwner, now, record.id, job, error)
  }
  if (status.state === 'PENDING' || status.state === 'RUNNING') {
    await options.database.alignmentJob.updateMany({
      where: { id: job.id, externalJobId: job.externalJobId },
      data: { status: 'POLLING', nextPollAt: new Date(now().getTime() + POLL_DELAY_MS), nextAttemptAt: null },
    })
    await options.database.processingHandoff.updateMany({
      where: { id: record.id, status: { in: ['PENDING', 'ASSESSING', 'ALIGNING'] } },
      data: { status: 'ALIGNING', submittedAt: now() },
    })
    return 'waiting'
  }
  if (status.state === 'FAILED' || status.state === 'CANCELLED') {
    const code = status.code ?? (status.state === 'CANCELLED' ? 'alignment_cancelled' : 'alignment_result_invalid')
    // A provider-declared terminal failure is not safe to resubmit: the
    // database freezes the job identity and external job id intentionally.
    // Only transient query/read failures below are retried against this same
    // immutable provider reservation.
    await options.database.alignmentJob.updateMany({
      where: { id: job.id },
      data: {
        status: status.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
        failedAt: now(),
        errorCode: code,
        nextPollAt: null,
        nextAttemptAt: null,
      },
    })
    await failHandoff(options, input, leaseOwner, now, record.id, code)
    return 'failed'
  }

  let result
  try {
    result = await options.alignment.read(job.externalJobId!)
  } catch (error) {
    return retryAlignmentOperation(options, input, leaseOwner, now, record.id, job, error)
  }
  const resolution = resolveAlignmentHandoff({
    expected,
    result,
    // F2 has no raw-object lifecycle authorization. The pure resolver
    // returns alignment_raw_unavailable instead of manufacturing a sentinel.
    proof: options.proof,
    methodProvider: 'fake_alignment',
    methodVersion: 'f2-runtime',
    modelRevision: 'fake-model',
  })
  if (resolution.kind !== 'accepted') {
    await options.database.alignmentJob.updateMany({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        failedAt: now(),
        errorCode: resolution.decisionCode,
        nextPollAt: null,
        nextAttemptAt: null,
      },
    })
    await failHandoff(options, input, leaseOwner, now, record.id, resolution.decisionCode)
    return 'failed'
  }

  await options.database.alignmentJob.updateMany({
    where: { id: job.id, status: { in: ['PENDING', 'SUBMITTED', 'POLLING'] } },
    data: { status: 'SUCCEEDED', completedAt: now(), nextPollAt: null, nextAttemptAt: null },
  })
  await materializeEvidence(options, input, leaseOwner, now, record.id, resolution.evidence, assessment)
  return 'accepted'
}

async function retryAlignmentOperation(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
  handoffId: string,
  job: { id: string; attempt: number; externalJobId: string | null; status: string },
  error: unknown,
): Promise<'waiting' | 'failed'> {
  const code = error instanceof AlignmentAdapterError && RETRYABLE_ALIGNMENT_CODES.has(error.code)
    ? error.code
    : null
  if (code && job.attempt < MAX_ALIGNMENT_ATTEMPTS) {
    const retried = await options.database.alignmentJob.updateMany({
      where: {
        id: job.id,
        ...(job.externalJobId ? { externalJobId: job.externalJobId } : {}),
        status: { in: ['PENDING', 'SUBMITTED', 'POLLING'] },
      },
      data: {
        status: job.externalJobId ? 'POLLING' : 'PENDING', attempt: job.attempt + 1, errorCode: code,
        nextPollAt: null, nextAttemptAt: new Date(now().getTime() + RETRY_DELAY_MS),
      },
    })
    if (retried.count === 1) return 'waiting'
  }
  const failureCode = code ?? 'alignment_result_invalid'
  await options.database.alignmentJob.updateMany({
    where: { id: job.id, status: { in: ['PENDING', 'SUBMITTED', 'POLLING'] } },
    data: { status: 'FAILED', failedAt: now(), errorCode: failureCode, nextPollAt: null, nextAttemptAt: null },
  })
  await failHandoff(options, input, leaseOwner, now, handoffId, failureCode)
  return 'failed'
}

async function ensureAlignmentJob(
  options: V2HandoffRuntimeOptions,
  record: { id: string; planRevision: number; logicalHandoffIndex: number },
  expected: ExpectedEvidenceIdentity,
) {
  const existing = await options.database.alignmentJob.findUnique({ where: { handoffId: record.id } })
  if (existing) return existing
  const idempotencyKey = buildAlignmentIdempotencyKey({
    processingRunId: expected.processingRunId,
    planRevision: record.planRevision,
    logicalHandoffIndex: record.logicalHandoffIndex,
    previousChunkId: expected.previousChunkId,
    previousAsrObjectKey: expected.previousAsrObjectKey,
    previousAsrVersionId: expected.previousAsrVersionId,
    previousAsrChecksum: expected.previousAsrChecksum,
    nextChunkId: expected.nextChunkId,
    nextAsrObjectKey: expected.nextAsrObjectKey,
    nextAsrVersionId: expected.nextAsrVersionId,
    nextAsrChecksum: expected.nextAsrChecksum,
    normalizedAudioVersionId: expected.normalizedAudioVersionId,
    normalizedAudioChecksum: expected.normalizedAudioChecksum,
    windowStartMs: expected.windowStartMs,
    windowEndMs: expected.windowEndMs,
    methodDigest: expected.methodDigest,
    modelDigest: expected.modelDigest,
    configDigest: expected.configDigest,
  })
  await options.database.processingHandoff.updateMany({
    where: { id: record.id, status: { in: ['PENDING', 'ASSESSING'] } },
    data: { status: 'ALIGNING' },
  })
  return options.database.alignmentJob.create({
    data: {
      handoffId: record.id,
      idempotencyKey,
      correlationHandle: createCorrelationHandle(),
      status: 'PENDING',
      attempt: 1,
      windowStartMs: expected.windowStartMs,
      windowEndMs: expected.windowEndMs,
      methodDigest: expected.methodDigest,
      modelDigest: expected.modelDigest,
      configDigest: expected.configDigest,
    },
  })
}

type AdoptionOutcome =
  | { kind: 'submission'; submission: AlignmentSubmission }
  | { kind: 'retry'; error: unknown }

async function adoptOrSubmit(
  options: V2HandoffRuntimeOptions,
  job: {
    idempotencyKey: string
    correlationHandle: string
    externalJobId: string | null
    windowStartMs: number
    windowEndMs: number
    methodDigest: string
    modelDigest: string
    configDigest: string
  },
): Promise<AdoptionOutcome> {
  if (job.externalJobId) {
    return { kind: 'submission', submission: { externalJobId: job.externalJobId, correlationHandle: job.correlationHandle } }
  }
  try {
    const recovered = await options.alignment.findByIdempotencyKey(job.idempotencyKey)
    if (recovered) return { kind: 'submission', submission: recovered }
  } catch (error) {
    return { kind: 'retry', error }
  }
  try {
    const submission = await options.alignment.submit({
      idempotencyKey: job.idempotencyKey,
      correlationHandle: job.correlationHandle,
      pipelineVersion: PIPELINE_VERSION_V2,
      windowStartMs: job.windowStartMs,
      windowEndMs: job.windowEndMs,
      methodDigest: job.methodDigest,
      modelDigest: job.modelDigest,
      configDigest: job.configDigest,
    })
    return { kind: 'submission', submission }
  } catch (submitError) {
    try {
      const recovered = await options.alignment.findByIdempotencyKey(job.idempotencyKey)
      if (recovered) return { kind: 'submission', submission: recovered }
      return { kind: 'retry', error: submitError }
    } catch (lookupError) {
      return { kind: 'retry', error: lookupError instanceof AlignmentAdapterError ? lookupError : submitError }
    }
  }
}

async function ensureHandoffRecord(
  database: PrismaClient,
  processingRunId: string,
  planRevision: number,
  logicalHandoffIndex: number,
  previous: EvidencingChunk,
  next: EvidencingChunk,
) {
  const where = {
    processingRunId_planRevision_logicalHandoffIndex: { processingRunId, planRevision, logicalHandoffIndex },
  }
  const existing = await database.processingHandoff.findUnique({ where })
  if (existing) return existing
  return database.processingHandoff.create({
    data: {
      processingRunId,
      planRevision,
      logicalHandoffIndex,
      previousChunkId: previous.id,
      nextChunkId: next.id,
      status: 'ASSESSING',
    },
  })
}

async function ensureAssessment(database: RuntimeDatabase, handoffId: string, assessment: AssessmentRecord): Promise<void> {
  const existing = await database.handoffAssessment.findUnique({ where: { handoffId }, select: { id: true } })
  if (existing) return
  await database.handoffAssessment.create({ data: { handoffId, ...assessment } })
}

function buildExpectedIdentity(
  processingRunId: string,
  record: { id: string; planRevision: number; logicalHandoffIndex: number },
  previous: EvidencingChunk,
  next: EvidencingChunk,
  windowStartMs: number,
  windowEndMs: number,
  options: V2HandoffRuntimeOptions,
): ExpectedEvidenceIdentity {
  return {
    handoffId: record.id,
    processingRunId,
    planRevision: record.planRevision,
    logicalHandoffIndex: record.logicalHandoffIndex,
    previousChunkId: previous.id,
    nextChunkId: next.id,
    // These schema identity slots intentionally remain empty in F2. A future
    // real-object integration must be separately contracted and may not reuse
    // this Fake route to smuggle object identifiers into proof material.
    previousAsrObjectKey: '',
    previousAsrVersionId: null,
    previousAsrChecksum: null,
    nextAsrObjectKey: '',
    nextAsrVersionId: null,
    nextAsrChecksum: null,
    normalizedAudioVersionId: null,
    normalizedAudioChecksum: null,
    windowStartMs,
    windowEndMs,
    methodDigest: options.methodDigest,
    modelDigest: options.modelDigest,
    configDigest: options.configDigest,
    alignmentPolicyDigest: null,
  }
}

function toHandoffChunkView(chunk: EvidencingChunk): HandoffChunkView {
  return {
    id: chunk.id,
    processingRunId: chunk.processingRunId,
    planRevision: chunk.planRevision,
    chunkIndex: chunk.chunkIndex,
    status: chunk.status,
    startMs: chunk.startMs,
    endMs: chunk.endMs,
  }
}

async function currentEffectivePlan(database: PrismaClient, processingRunId: string, planRevision: number): Promise<EvidencingChunk[]> {
  const candidates = await database.processingChunk.findMany({
    where: { processingRunId, planRevision: { lte: planRevision } },
    orderBy: [{ chunkIndex: 'asc' }, { planRevision: 'desc' }],
    select: {
      id: true,
      processingRunId: true,
      planRevision: true,
      chunkIndex: true,
      status: true,
      startMs: true,
      endMs: true,
    },
  })
  const effective = new Map<number, EvidencingChunk>()
  for (const candidate of candidates) {
    if (!effective.has(candidate.chunkIndex)) effective.set(candidate.chunkIndex, candidate)
  }
  return [...effective.values()].sort((left, right) => left.chunkIndex - right.chunkIndex)
}

async function materializeEvidence(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
  handoffId: string,
  evidence: MaterializedEvidence,
  assessment?: AssessmentRecord,
): Promise<void> {
  await options.database.$transaction(async (transaction) => {
    await requireLease(transaction, input, leaseOwner, now, options.leaseMs ?? DEFAULT_LEASE_MS)
    const existing = await transaction.handoffEvidence.findUnique({ where: { handoffId }, select: { id: true } })
    if (!existing) {
      if (assessment) await ensureAssessment(transaction, handoffId, assessment)
      await transaction.handoffEvidence.create({ data: { handoffId, ...evidence } })
    }
    await transaction.processingHandoff.updateMany({
      where: { id: handoffId, status: { in: ['PENDING', 'ASSESSING', 'ALIGNING'] } },
      data: { status: 'EVIDENCED', completedAt: now(), errorCode: null, leaseOwner: null, leaseExpiresAt: null },
    })
  })
}

async function failHandoff(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
  handoffId: string | null,
  errorCode: string,
): Promise<void> {
  await options.database.$transaction(async (transaction) => {
    await requireLease(transaction, input, leaseOwner, now, options.leaseMs ?? DEFAULT_LEASE_MS)
    if (handoffId) {
      await transaction.processingHandoff.updateMany({
        where: { id: handoffId, status: { in: ['PENDING', 'ASSESSING', 'ALIGNING'] } },
        data: { status: 'FAILED', failedAt: now(), errorCode, leaseOwner: null, leaseExpiresAt: null },
      })
    }
    const failed = await transaction.processingRun.updateMany({
      where: {
        id: input.processingRunId,
        mediaAssetId: input.mediaAssetId,
        status: 'PROCESSING',
        leaseOwner,
      },
      data: {
        status: 'FAILED',
        failedAt: now(),
        errorCode: 'transcript_incomplete',
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    })
    if (failed.count !== 1) throw new V2HandoffRuntimeError('handoff_lease_lost', 'run lease was lost while failing handoff')
  })
}

async function releaseLease(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
): Promise<void> {
  const released = await options.database.processingRun.updateMany({
    where: {
      id: input.processingRunId,
      mediaAssetId: input.mediaAssetId,
      status: 'PROCESSING',
      stage: 'HANDOFF_EVIDENCING',
      leaseOwner,
      leaseExpiresAt: { gt: now() },
    },
    data: { leaseOwner: null, leaseExpiresAt: null },
  })
  if (released.count !== 1) throw new V2HandoffRuntimeError('handoff_lease_lost', 'run lease was lost while waiting for alignment')
}

async function advanceToMerging(
  options: V2HandoffRuntimeOptions,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
): Promise<void> {
  const advanced = await options.database.processingRun.updateMany({
    where: {
      id: input.processingRunId,
      mediaAssetId: input.mediaAssetId,
      pipelineVersion: PIPELINE_VERSION_V2,
      status: 'PROCESSING',
      stage: 'HANDOFF_EVIDENCING',
      leaseOwner,
      leaseExpiresAt: { gt: now() },
    },
    data: { stage: 'MERGING', leaseOwner: null, leaseExpiresAt: null },
  })
  if (advanced.count !== 1) throw new V2HandoffRuntimeError('handoff_lease_lost', 'run lease was lost while advancing to MERGING')
}

async function requireLease(
  database: RuntimeDatabase,
  input: V2HandoffRuntimeInput,
  leaseOwner: string,
  now: () => Date,
  leaseMs: number,
): Promise<void> {
  const extended = await database.processingRun.updateMany({
    where: {
      id: input.processingRunId,
      mediaAssetId: input.mediaAssetId,
      status: 'PROCESSING',
      stage: 'HANDOFF_EVIDENCING',
      leaseOwner,
      leaseExpiresAt: { gt: now() },
    },
    data: { leaseExpiresAt: new Date(now().getTime() + leaseMs) },
  })
  if (extended.count !== 1) throw new V2HandoffRuntimeError('handoff_lease_lost', 'run lease was lost')
}
