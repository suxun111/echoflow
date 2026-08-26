/**
 * G3 v2 deterministic foundation — handoff domain types and whitelists.
 *
 * All values are NON-CONTENT metadata. Nothing in this module (or its
 * fixtures/tests) may carry subtitle text, tokens, word timings, audio
 * bytes, raw provider results, object keys/URLs, digests of private
 * content, or any secret. Identity fields are represented by opaque
 * synthetic identifiers only.
 */

export const SCHEMA_VERSION = '1'
export const PIPELINE_VERSION_V2 = 'g3-transcript-v2'
export const MAX_AUTOMATIC_PLAN_REVISIONS = 1
export const MAX_ALIGNMENT_ATTEMPTS = 3
export const MIN_STRONG_ANCHORS = 2
export const MIN_STRONG_CANDIDATE_TOKENS = 2

/** Final accepted evidence types (v2 frozen whitelist). */
export const EVIDENCE_TYPES = ['strict_segment', 'boundary_forced_alignment'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

/** provider_native_word_timing is deliberately NOT in the whitelist. */
export const FORBIDDEN_EVIDENCE_TYPE = 'provider_native_word_timing' as const

export const HANDOFF_DECISIONS = ['accepted', 'insufficient', 'ambiguous'] as const
export type HandoffDecision = (typeof HANDOFF_DECISIONS)[number]

export const STRICT_DECISIONS = ['accepted', 'insufficient', 'ambiguous'] as const
export type StrictDecision = (typeof STRICT_DECISIONS)[number]

export const STRICT_ACCEPTED_CODE = 'strict_segment_accepted'
export const EVIDENCE_ACCEPTED_CODE = 'evidence_accepted'

export const STRICT_INSUFFICIENT_CODES = [
  'no_handoff_text',
  'single_token_candidate',
  'window_out_of_bounds',
  'mixed_granularity',
  'missing_fields',
  'identity_mismatch',
  'result_invalid',
] as const
export type StrictInsufficientCode = (typeof STRICT_INSUFFICIENT_CODES)[number]

/** Revision 0 -> 1 overlay repair codes (TranscriptRepairDiagnostic whitelist). */
export const REPAIR_CODES = [
  'no_textual_suffix_prefix',
  'text_match_without_time_overlap',
  'text_time_match_with_speaker_conflict',
  'multiple_valid_alignments',
  'weak_single_token_alignment',
] as const
export type RepairCode = (typeof REPAIR_CODES)[number]

export const ALIGNMENT_INSUFFICIENT_CODES = [
  'alignment_unavailable',
  'alignment_timeout',
  'alignment_rate_limited',
  'alignment_input_mismatch',
  'alignment_result_invalid',
  'alignment_cancelled',
] as const
export type AlignmentInsufficientCode = (typeof ALIGNMENT_INSUFFICIENT_CODES)[number]

export const HANDOFF_STATUSES = ['PENDING', 'ASSESSING', 'ALIGNING', 'EVIDENCED', 'FAILED', 'CANCELLED'] as const
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]

export const ALIGNMENT_JOB_STATUSES = ['PENDING', 'SUBMITTED', 'POLLING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type AlignmentJobStatus = (typeof ALIGNMENT_JOB_STATUSES)[number]

export const HEX64 = /^[a-f0-9]{64}$/

export interface HCounts {
  hTotal: number
  hUnique: number
  hR1: number
  hUnresolved: number
  hSegment: number
  hProviderWord: number
  hAlignment: number
}

export const ZERO_H_COUNTS: HCounts = {
  hTotal: 0,
  hUnique: 0,
  hR1: 0,
  hUnresolved: 0,
  hSegment: 0,
  hProviderWord: 0,
  hAlignment: 0,
}

/** Immutable chunk identity subset used by handoff validation. */
export interface ChunkIdentity {
  id: string
  processingRunId: string
  planRevision: number
  chunkIndex: number
  status: string
  resultObjectKey?: string | null
  resultVersionId?: string | null
  resultChecksum?: string | null
}

/** Structured, content-free input for the strict segment assessment. */
export interface StrictCandidate {
  startMs: number
  endMs: number
  tokenCount: number
  hasSpeakerConflict: boolean
}

export interface StrictSegmentInput {
  leftChunk: ChunkIdentity
  rightChunk: ChunkIdentity
  planRevision: number
  windowStartMs: number
  windowEndMs: number
  inputChecksum: string
  candidates: StrictCandidate[]
  missingFields: string[]
  mixedGranularity: boolean
  windowOutOfBounds: boolean
  hasTimeConflict: boolean
  hasSpeakerConflict: boolean
}

export interface StrictAssessment {
  decision: StrictDecision
  decisionCode: StrictInsufficientCode | RepairCode | typeof STRICT_ACCEPTED_CODE
  evidenceType: 'strict_segment'
  windowStartMs: number
  windowEndMs: number
}
