/**
 * TranscriptRunArbiter — serializes v1/v2 transcript-pipeline ownership per
 * media asset and enforces mutual exclusion, idempotency and lease fencing.
 *
 * All v1 auto-run creation and v2 explicit enrollment MUST pass through
 * `arbitrateTranscriptRun`. It runs inside a caller-managed Prisma
 * transaction and takes a PostgreSQL advisory lock keyed by media asset so
 * that concurrent requests for the same asset cannot interleave.
 *
 * F2 scope: this module only reads/writes ProcessingRun + OutboxEvent +
 * TranscriptVersion. It never touches media, object storage or networks.
 */

import { randomUUID } from 'node:crypto'
import type { Prisma, ProcessingRun, ProcessingStage, TranscriptVersion } from '@prisma/client'

export const G3_TRANSCRIPT_PIPELINES = ['g3-transcript-v1', 'g3-transcript-v2'] as const
export type G3TranscriptPipeline = (typeof G3_TRANSCRIPT_PIPELINES)[number]

export const G3_PIPELINE_VERSION_V2 = 'g3-transcript-v2' as const
export const G3_PIPELINE_VERSION_V1 = 'g3-transcript-v1' as const
export const MAX_V2_ENROLL_DURATION_MS = 60 * 60 * 1_000

export const ARBITER_CONFLICT_REASONS = ['other_pipeline_holds_media'] as const
export const ARBITER_NOT_ELIGIBLE_REASONS = [
  'asset_not_found',
  'not_playable',
  'deleted',
  'owner_mismatch',
  'duration_exceeds_limit',
  'active_transcript_exists',
  'prior_pipeline_not_failed_or_cancelled',
  'v2_run_already_terminal',
  'explicit_enrollment_required',
] as const

export type ArbiterOutcome =
  | { kind: 'created'; processingRunId: string }
  | { kind: 'idempotent'; processingRunId: string }
  | { kind: 'conflict'; reason: (typeof ARBITER_CONFLICT_REASONS)[number] }
  | { kind: 'not_eligible'; reason: (typeof ARBITER_NOT_ELIGIBLE_REASONS)[number] }

export interface ArbitrateRequest {
  mediaAssetId: string
  /** The pipeline this request wants to own the media for. */
  pipelineVersion: G3TranscriptPipeline
  /** Stage assigned to a newly created run. */
  startStage: ProcessingStage
  /** Outbox event emitted when a run is created. */
  eventType: string
  /** Idempotency key for the emitted outbox event. */
  idempotencyKey: string
  /** Required owner for explicit enrollment (v2); omitted for v1 auto-run. */
  ownerId?: string
  /** v2: refuse if the asset already has an ACTIVE transcript of another pipeline. */
  requireNoActiveTranscript?: boolean
  /** v2: maximum asset duration in ms (0 means no limit). */
  maxDurationMs?: number
  /** Marks an API v2 enrollment; the idempotency key remains opaque. */
  explicitEnrollment?: boolean
  /** Opaque test-only queue handle; never a media/run database identifier. */
  queueCorrelationHandle?: string
}

interface ArbitratedState {
  asset: { id: string; ownerId: string; status: string; durationMs: number | null; deletedAt: Date | null } | null
  g3Runs: ProcessingRun[]
  activeTranscript: TranscriptVersion | null
}

const ACTIVE_RUN_STATUSES = ['QUEUED', 'PROCESSING', 'VALIDATING'] as const

/** Take the per-asset advisory lock. Must run inside a transaction. */
export async function acquireTranscriptArbiterLock(
  tx: Prisma.TransactionClient,
  mediaAssetId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${mediaAssetId}, 0))`
}

async function readArbitratedState(
  tx: Prisma.TransactionClient,
  mediaAssetId: string,
): Promise<ArbitratedState> {
  const [asset, g3Runs, activeTranscript] = await Promise.all([
    tx.mediaAsset.findUnique({
      where: { id: mediaAssetId },
      select: { id: true, ownerId: true, status: true, durationMs: true, deletedAt: true },
    }),
    tx.processingRun.findMany({
      where: { mediaAssetId, pipelineVersion: { in: [...G3_TRANSCRIPT_PIPELINES] } },
      orderBy: { createdAt: 'asc' },
    }),
    tx.transcriptVersion.findFirst({
      where: { mediaAssetId, status: 'ACTIVE' },
      orderBy: { version: 'desc' },
    }),
  ])
  return { asset, g3Runs, activeTranscript }
}

/**
 * Decide whether the media can be enrolled for `pipelineVersion` and, if so,
 * create the unique run + outbox event. Idempotent per pipeline.
 */
export async function arbitrateTranscriptRun(
  tx: Prisma.TransactionClient,
  request: ArbitrateRequest,
): Promise<ArbiterOutcome> {
  await acquireTranscriptArbiterLock(tx, request.mediaAssetId)
  const state = await readArbitratedState(tx, request.mediaAssetId)

  if (!state.asset) return { kind: 'not_eligible', reason: 'asset_not_found' }
  if (state.asset.deletedAt !== null) return { kind: 'not_eligible', reason: 'deleted' }
  if (state.asset.status !== 'PLAYABLE') return { kind: 'not_eligible', reason: 'not_playable' }
  // Keep the v2 gate in the arbiter as well as the HTTP controller.  This
  // prevents a future internal caller from creating a v2 run that bypasses
  // owner consent, the duration bound, or the isolated Fake-only route.
  if (request.pipelineVersion === G3_PIPELINE_VERSION_V2 && (
    request.explicitEnrollment !== true
    || !request.ownerId
    || request.requireNoActiveTranscript !== true
    || request.maxDurationMs !== MAX_V2_ENROLL_DURATION_MS
    || request.startStage !== 'HANDOFF_EVIDENCING'
    || request.eventType !== 'media.transcript_process.v2'
    || !request.queueCorrelationHandle
    || !/^[A-Za-z0-9._:-]{8,128}$/.test(request.queueCorrelationHandle)
  )) {
    return { kind: 'not_eligible', reason: 'explicit_enrollment_required' }
  }
  if (request.ownerId !== undefined && state.asset.ownerId !== request.ownerId) {
    return { kind: 'not_eligible', reason: 'owner_mismatch' }
  }
  if (request.maxDurationMs !== undefined && request.maxDurationMs > 0) {
    if (state.asset.durationMs === null) return { kind: 'not_eligible', reason: 'duration_exceeds_limit' }
    if (state.asset.durationMs <= 0 || state.asset.durationMs > request.maxDurationMs) {
      return { kind: 'not_eligible', reason: 'duration_exceeds_limit' }
    }
  }

  const ownRun = state.g3Runs.find((run) => run.pipelineVersion === request.pipelineVersion)
  if (ownRun) {
    if (request.explicitEnrollment && request.pipelineVersion === G3_PIPELINE_VERSION_V2) {
      // The public Idempotency-Key is hashed by the API before it reaches this
      // function.  Only the exact request's opaque Outbox identity may replay;
      // another request must not become an accidental v2 retry.
      const matchingRequest = await tx.outboxEvent.findUnique({ where: { idempotencyKey: request.idempotencyKey } })
      if (matchingRequest?.aggregateType === 'ProcessingRun' && matchingRequest.aggregateId === ownRun.id) {
        return { kind: 'idempotent', processingRunId: ownRun.id }
      }
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(ownRun.status)) {
        return { kind: 'conflict', reason: 'other_pipeline_holds_media' }
      }
      return { kind: 'not_eligible', reason: 'v2_run_already_terminal' }
    }
    return { kind: 'idempotent', processingRunId: ownRun.id }
  }

  // Mutual exclusion: a different G3 transcript pipeline must not be allowed
  // to enroll while another holds the media (active run or active transcript).
  const otherPipelineActive = state.g3Runs.some(
    (run) =>
      run.pipelineVersion !== request.pipelineVersion &&
      (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
  )

  // v2 enrollment refuses any existing ACTIVE transcript (a supersede would
  // need a separate contract). This must be checked before the generic
  // conflict so the caller receives the more specific eligibility reason.
  if (request.requireNoActiveTranscript && state.activeTranscript !== null) {
    return { kind: 'not_eligible', reason: 'active_transcript_exists' }
  }

  const otherPipelineOwnsTranscript =
    state.activeTranscript !== null && state.activeTranscript.pipelineVersion !== request.pipelineVersion

  if (otherPipelineActive || otherPipelineOwnsTranscript) {
    return { kind: 'conflict', reason: 'other_pipeline_holds_media' }
  }

  // F2 intentionally permits an explicit v2 enrollment only as a replacement
  // for a failed or cancelled v1 attempt.  A v1 run which says it succeeded
  // but has no ACTIVE transcript is still not a valid upgrade path; treating
  // it as one would silently bypass the separately-frozen supersede policy.
  if (request.pipelineVersion === G3_PIPELINE_VERSION_V2) {
    const priorV1 = state.g3Runs.find((run) => run.pipelineVersion === G3_PIPELINE_VERSION_V1)
    if (priorV1 && !['FAILED', 'CANCELLED'].includes(priorV1.status)) {
      return { kind: 'not_eligible', reason: 'prior_pipeline_not_failed_or_cancelled' }
    }
  }

  const processingRunId = randomUUID()
  await tx.processingRun.create({
    data: {
      id: processingRunId,
      ownerId: state.asset.ownerId,
      mediaAssetId: request.mediaAssetId,
      pipelineVersion: request.pipelineVersion,
      stage: request.startStage,
      status: 'QUEUED',
      ...(request.pipelineVersion === G3_PIPELINE_VERSION_V2 ? { requestId: request.queueCorrelationHandle } : {}),
    },
  })
  await tx.outboxEvent.upsert({
    where: { idempotencyKey: request.idempotencyKey },
    create: {
      aggregateType: request.pipelineVersion === G3_PIPELINE_VERSION_V2 ? 'ProcessingRun' : 'MediaAsset',
      aggregateId: request.pipelineVersion === G3_PIPELINE_VERSION_V2 ? processingRunId : request.mediaAssetId,
      eventType: request.eventType,
      idempotencyKey: request.idempotencyKey,
      payload: request.pipelineVersion === G3_PIPELINE_VERSION_V2
        ? { v2JobHandle: request.queueCorrelationHandle! }
        : { mediaAssetId: request.mediaAssetId, processingRunId },
    },
    update: {},
  })

  return { kind: 'created', processingRunId }
}
