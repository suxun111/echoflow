/**
 * Pure handoff/evidence validators for the G3 v2 deterministic foundation.
 *
 * Everything here is a pure function over structured, NON-CONTENT metadata.
 * These validators mirror the whitelists frozen in
 * packages/database/prisma/migrations/20260826000100_g3_v2_deterministic_foundation.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  ALIGNMENT_INSUFFICIENT_CODES,
  EVIDENCE_TYPES,
  FORBIDDEN_EVIDENCE_TYPE,
  HANDOFF_DECISIONS,
  HEX64,
  MIN_STRONG_CANDIDATE_TOKENS,
  PIPELINE_VERSION_V2,
  REPAIR_CODES,
  STRICT_ACCEPTED_CODE,
  STRICT_DECISIONS,
  STRICT_INSUFFICIENT_CODES,
  type ChunkIdentity,
  type EvidenceType,
  type HandoffDecision,
  type RepairCode,
  type StrictAssessment,
  type StrictInsufficientCode,
  type StrictSegmentInput,
} from './types'

export const HANDOFF_VALIDATION_CODES = [
  'handoff_not_adjacent',
  'handoff_cross_run',
  'handoff_revision_mismatch',
  'handoff_invalid_chunk',
  'handoff_self_reference',
] as const
export type HandoffValidationCode = (typeof HANDOFF_VALIDATION_CODES)[number]

export class HandoffValidationError extends Error {
  constructor(
    readonly code: HandoffValidationCode,
    message: string,
  ) {
    super(message)
    this.name = 'HandoffValidationError'
  }
}

/**
 * A logical handoff covers adjacent positions (i, i+1) of the current
 * effective plan. Left/right chunks must share the run, share the handoff
 * plan revision, be strictly adjacent, be valid (SUCCEEDED) and never self.
 */
export function validateHandoffPair(
  previous: ChunkIdentity,
  next: ChunkIdentity,
  planRevision: number,
): void {
  if (previous.id === next.id) {
    throw new HandoffValidationError('handoff_self_reference', 'handoff must not reference the same chunk twice')
  }
  if (previous.processingRunId !== next.processingRunId) {
    throw new HandoffValidationError('handoff_cross_run', 'left and right chunks must belong to the same run')
  }
  if (previous.planRevision !== planRevision || next.planRevision !== planRevision) {
    throw new HandoffValidationError('handoff_revision_mismatch', 'chunks must belong to the handoff plan revision')
  }
  if (next.chunkIndex !== previous.chunkIndex + 1) {
    throw new HandoffValidationError('handoff_not_adjacent', 'chunks must be adjacent (i, i+1)')
  }
  if (previous.status !== 'SUCCEEDED' || next.status !== 'SUCCEEDED') {
    throw new HandoffValidationError('handoff_invalid_chunk', 'both chunks must be valid (SUCCEEDED)')
  }
}

/**
 * Deterministic strict segment assessment over structured candidate
 * metadata (no text/timing content). Mirrors the DB whitelist:
 * accepted -> strict_segment_accepted;
 * insufficient -> strict insufficient codes;
 * ambiguous -> revision-1 repair codes.
 */
export function validateStrictSegment(input: StrictSegmentInput): StrictAssessment {
  const { windowStartMs, windowEndMs } = input
  const fail = (decisionCode: StrictInsufficientCode): StrictAssessment => ({
    decision: 'insufficient',
    decisionCode,
    evidenceType: 'strict_segment',
    windowStartMs,
    windowEndMs,
  })

  if (input.missingFields.length > 0) return fail('missing_fields')
  if (input.windowOutOfBounds) return fail('window_out_of_bounds')
  if (input.mixedGranularity) return fail('mixed_granularity')
  if (input.leftChunk.status !== 'SUCCEEDED' || input.rightChunk.status !== 'SUCCEEDED') return fail('identity_mismatch')
  if (input.leftChunk.processingRunId !== input.rightChunk.processingRunId) return fail('identity_mismatch')
  if (input.leftChunk.planRevision !== input.planRevision || input.rightChunk.planRevision !== input.planRevision) {
    return fail('identity_mismatch')
  }
  if (!HEX64.test(input.inputChecksum)) return fail('result_invalid')
  if (input.candidates.length === 0) return fail('no_handoff_text')

  const ambiguous = (code: RepairCode): StrictAssessment => ({
    decision: 'ambiguous',
    decisionCode: code,
    evidenceType: 'strict_segment',
    windowStartMs,
    windowEndMs,
  })

  if (input.candidates.length === 1) {
    const candidate = input.candidates[0]!
    if (candidate.tokenCount < MIN_STRONG_CANDIDATE_TOKENS) return fail('single_token_candidate')
    if (input.hasSpeakerConflict || candidate.hasSpeakerConflict) {
      return ambiguous('text_time_match_with_speaker_conflict')
    }
    if (input.hasTimeConflict) return ambiguous('text_match_without_time_overlap')
    return {
      decision: 'accepted',
      decisionCode: STRICT_ACCEPTED_CODE,
      evidenceType: 'strict_segment',
      windowStartMs,
      windowEndMs,
    }
  }

  // Multiple candidates: no unique decision without an explicit boundary signal.
  if (input.hasSpeakerConflict) return ambiguous('text_time_match_with_speaker_conflict')
  if (input.candidates.every((candidate) => candidate.tokenCount < MIN_STRONG_CANDIDATE_TOKENS)) {
    return ambiguous('weak_single_token_alignment')
  }
  if (input.hasTimeConflict) return ambiguous('multiple_valid_alignments')
  return ambiguous('no_textual_suffix_prefix')
}

export interface ExpectedEvidenceIdentity {
  handoffId: string
  processingRunId: string
  planRevision: number
  logicalHandoffIndex: number
  previousChunkId: string
  nextChunkId: string
  previousAsrObjectKey: string
  previousAsrVersionId: string | null
  previousAsrChecksum: string | null
  nextAsrObjectKey: string
  nextAsrVersionId: string | null
  nextAsrChecksum: string | null
  normalizedAudioVersionId: string | null
  normalizedAudioChecksum: string | null
  windowStartMs: number
  windowEndMs: number
  methodDigest: string
  modelDigest: string
  configDigest: string
  alignmentPolicyDigest?: string | null
}

export interface EvidenceIdentityView {
  planRevision: number
  logicalHandoffIndex: number
  decision: HandoffDecision
  decisionCode: string
  evidenceType: EvidenceType
  previousChunkId: string
  nextChunkId: string
  previousAsrObjectKey: string
  previousAsrVersionId: string | null
  previousAsrChecksum: string | null
  nextAsrObjectKey: string
  nextAsrVersionId: string | null
  nextAsrChecksum: string | null
  normalizedAudioVersionId: string | null
  normalizedAudioChecksum: string | null
  windowStartMs: number
  windowEndMs: number
  methodProvider: string
  methodVersion: string
  modelRevision: string | null
  alignmentPolicyDigest: string | null
}

export const EVIDENCE_VALIDATION_CODES = [
  'evidence_identity_mismatch',
  'evidence_type_not_whitelisted',
  'evidence_decision_not_whitelisted',
  'evidence_decision_code_not_whitelisted',
  'evidence_window_invalid',
  'evidence_provider_word_forbidden',
  'evidence_raw_incomplete',
  'evidence_checksum_invalid',
] as const
export type EvidenceValidationCode = (typeof EVIDENCE_VALIDATION_CODES)[number]

export class EvidenceValidationError extends Error {
  constructor(
    readonly code: EvidenceValidationCode,
    message: string,
  ) {
    super(message)
    this.name = 'EvidenceValidationError'
  }
}

/**
 * A final accepted evidence must be bound to exactly the expected handoff
 * identity and to exact input/ASR/audio/window/method identity. Any
 * checksum/version mismatch rejects; nothing may ever claim the
 * provider_native_word_timing type.
 */
export function validateEvidenceIdentity(evidence: EvidenceIdentityView, expected: ExpectedEvidenceIdentity): void {
  if (evidence.planRevision !== expected.planRevision || evidence.logicalHandoffIndex !== expected.logicalHandoffIndex) {
    throw new EvidenceValidationError('evidence_identity_mismatch', 'evidence revision/pair does not match the handoff')
  }
  if (evidence.previousChunkId !== expected.previousChunkId || evidence.nextChunkId !== expected.nextChunkId) {
    throw new EvidenceValidationError('evidence_identity_mismatch', 'evidence chunk identity does not match the handoff')
  }
  if (
    evidence.previousAsrObjectKey !== expected.previousAsrObjectKey ||
    evidence.previousAsrVersionId !== expected.previousAsrVersionId ||
    evidence.previousAsrChecksum !== expected.previousAsrChecksum ||
    evidence.nextAsrObjectKey !== expected.nextAsrObjectKey ||
    evidence.nextAsrVersionId !== expected.nextAsrVersionId ||
    evidence.nextAsrChecksum !== expected.nextAsrChecksum
  ) {
    throw new EvidenceValidationError('evidence_identity_mismatch', 'evidence ASR input identity does not match')
  }
  if (
    evidence.normalizedAudioVersionId !== expected.normalizedAudioVersionId ||
    evidence.normalizedAudioChecksum !== expected.normalizedAudioChecksum
  ) {
    throw new EvidenceValidationError('evidence_identity_mismatch', 'evidence normalized audio identity does not match')
  }
  if (evidence.windowStartMs !== expected.windowStartMs || evidence.windowEndMs !== expected.windowEndMs) {
    throw new EvidenceValidationError('evidence_window_invalid', 'evidence window does not match the registered boundary window')
  }
  if (evidence.windowEndMs <= evidence.windowStartMs) {
    throw new EvidenceValidationError('evidence_window_invalid', 'evidence window must be non-empty and ordered')
  }
  if (!EVIDENCE_TYPES.includes(evidence.evidenceType)) {
    throw new EvidenceValidationError('evidence_type_not_whitelisted', `evidenceType must be one of ${EVIDENCE_TYPES.join(', ')}`)
  }
  if ((evidence.evidenceType as string) === FORBIDDEN_EVIDENCE_TYPE) {
    throw new EvidenceValidationError('evidence_provider_word_forbidden', 'provider_native_word_timing is not permitted in v2')
  }
  if (!HANDOFF_DECISIONS.includes(evidence.decision)) {
    throw new EvidenceValidationError('evidence_decision_not_whitelisted', 'decision must be accepted | insufficient | ambiguous')
  }
  if (!isDecisionCodeAllowed(evidence.decision, evidence.decisionCode, evidence.evidenceType)) {
    throw new EvidenceValidationError('evidence_decision_code_not_whitelisted', 'decisionCode is not on the whitelist for this decision')
  }
  for (const checksum of [
    evidence.previousAsrChecksum,
    evidence.nextAsrChecksum,
    evidence.normalizedAudioChecksum,
  ]) {
    if (checksum !== null && checksum !== undefined && !HEX64.test(checksum)) {
      throw new EvidenceValidationError('evidence_checksum_invalid', 'checksum must be 64 lowercase hex chars')
    }
  }
  if (evidence.decision === 'accepted' && evidence.evidenceType === 'boundary_forced_alignment' && !expected.methodDigest) {
    throw new EvidenceValidationError('evidence_raw_incomplete', 'alignment evidence requires a method/config identity')
  }
}

function isDecisionCodeAllowed(decision: HandoffDecision, code: string, evidenceType: EvidenceType): boolean {
  if (decision === 'accepted') return code === 'evidence_accepted' && EVIDENCE_TYPES.includes(evidenceType)
  if (decision === 'insufficient') return (ALIGNMENT_INSUFFICIENT_CODES as readonly string[]).includes(code)
  if (decision === 'ambiguous') return (REPAIR_CODES as readonly string[]).includes(code)
  return false
}

export const isStrictInsufficientCode = (code: string): code is StrictInsufficientCode =>
  (STRICT_INSUFFICIENT_CODES as readonly string[]).includes(code)

export const isRepairCode = (code: string): code is RepairCode => (REPAIR_CODES as readonly string[]).includes(code)

/**
 * Stable idempotency identity for a boundary alignment job. Any material
 * change (run, revision, pair, input/result identity, audio, window, method,
 * model or config digest) must produce a NEW identity, never a retry of an
 * old job.
 */
export interface AlignmentIdempotencyInput {
  processingRunId: string
  planRevision: number
  logicalHandoffIndex: number
  previousChunkId: string
  previousAsrObjectKey: string
  previousAsrVersionId: string | null
  previousAsrChecksum: string | null
  nextChunkId: string
  nextAsrObjectKey: string
  nextAsrVersionId: string | null
  nextAsrChecksum: string | null
  normalizedAudioVersionId: string | null
  normalizedAudioChecksum: string | null
  windowStartMs: number
  windowEndMs: number
  methodDigest: string
  modelDigest: string
  configDigest: string
}

export function buildAlignmentIdempotencyKey(input: AlignmentIdempotencyInput): string {
  const canonical = canonicalJson({ pipelineVersion: PIPELINE_VERSION_V2, ...input })
  return `g3v2:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Stable serialization with sorted keys, independent of caller key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    ordered[key] = (value as Record<string, unknown>)[key]
  }
  return JSON.stringify(ordered)
}

/** Opaque correlation handle: random, not reversible to any database row. */
export function createCorrelationHandle(): string {
  return randomBytes(24).toString('hex')
}
