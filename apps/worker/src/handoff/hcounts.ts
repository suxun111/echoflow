/**
 * H_* aggregation and pre-publish assertions for the G3 v2 foundation.
 *
 * Counts are ALWAYS recomputed from persisted handoff records of the
 * current effective revision only; old revisions stay immutable history
 * and never contribute to H_* or to publication.
 */

import {
  EVIDENCE_TYPES,
  FORBIDDEN_EVIDENCE_TYPE,
  MAX_AUTOMATIC_PLAN_REVISIONS,
  type EvidenceType,
  type HCounts,
  type HandoffDecision,
} from './types'
import {
  EvidenceValidationError,
  validateEvidenceIdentity,
  type EvidenceIdentityView,
  type ExpectedEvidenceIdentity,
} from './validators'

export interface HandoffCountEntry {
  logicalHandoffIndex: number
  firstAcceptedRevision: 0 | 1
  decision: HandoffDecision
  evidenceType: EvidenceType | null
}

export const H_COUNT_CODES = [
  'h_counts_non_negative_violated',
  'h_counts_equality_violated',
  'h_provider_word_nonzero',
  'h_handoff_missing',
  'h_handoff_duplicate',
  'h_handoff_unclassified',
  'h_revision_out_of_range',
] as const
export type HCountCode = (typeof H_COUNT_CODES)[number]

export class HCountError extends Error {
  constructor(
    readonly code: HCountCode,
    message: string,
  ) {
    super(message)
    this.name = 'HCountError'
  }
}

/**
 * Recompute H_* for the current effective revision.
 * hTotal = max(effectiveChunkCount - 1, 0); every logical handoff of the
 * revision must be present exactly once with a whitelisted final decision.
 */
export function recomputeHCounts(effectiveChunkCount: number, entries: HandoffCountEntry[]): HCounts {
  const hTotal = Math.max(effectiveChunkCount - 1, 0)
  const byIndex = new Map<number, HandoffCountEntry>()
  for (const entry of entries) {
    if (byIndex.has(entry.logicalHandoffIndex)) {
      throw new HCountError('h_handoff_duplicate', `duplicate final handoff record at index ${entry.logicalHandoffIndex}`)
    }
    byIndex.set(entry.logicalHandoffIndex, entry)
  }
  for (let index = 0; index < hTotal; index += 1) {
    if (!byIndex.has(index)) {
      throw new HCountError('h_handoff_missing', `missing final handoff record at index ${index}`)
    }
  }
  if (entries.length > hTotal) {
    throw new HCountError('h_handoff_unclassified', 'handoff records outside the current effective plan')
  }

  let hUnique = 0
  let hR1 = 0
  let hUnresolved = 0
  let hSegment = 0
  let hProviderWord = 0
  let hAlignment = 0

  for (const entry of entries) {
    if (entry.firstAcceptedRevision < 0 || entry.firstAcceptedRevision > MAX_AUTOMATIC_PLAN_REVISIONS) {
      throw new HCountError('h_revision_out_of_range', 'firstAcceptedRevision must be 0 or 1')
    }
    if (entry.decision === 'accepted') {
      if ((entry.evidenceType as string | null) === FORBIDDEN_EVIDENCE_TYPE) {
        throw new HCountError('h_provider_word_nonzero', 'provider_native_word_timing is not permitted')
      }
      if (entry.evidenceType === null || !EVIDENCE_TYPES.includes(entry.evidenceType)) {
        throw new HCountError('h_handoff_unclassified', 'accepted handoff must carry a whitelisted evidenceType')
      }
      if (entry.firstAcceptedRevision === 0) hUnique += 1
      else hR1 += 1
      if (entry.evidenceType === 'strict_segment') hSegment += 1
      else hAlignment += 1
    } else if (entry.decision === 'insufficient' || entry.decision === 'ambiguous') {
      hUnresolved += 1
    } else {
      throw new HCountError('h_handoff_unclassified', `unclassified handoff decision ${entry.decision}`)
    }
  }

  const counts: HCounts = { hTotal, hUnique, hR1, hUnresolved, hSegment, hProviderWord, hAlignment }
  assertHCounts(counts)
  return counts
}

/** DB-equivalent checks: non-negative, both equalities, hProviderWord = 0. */
export function assertHCounts(counts: HCounts): void {
  const nonNegative =
    counts.hTotal >= 0 &&
    counts.hUnique >= 0 &&
    counts.hR1 >= 0 &&
    counts.hUnresolved >= 0 &&
    counts.hSegment >= 0 &&
    counts.hProviderWord >= 0 &&
    counts.hAlignment >= 0
  if (!nonNegative) throw new HCountError('h_counts_non_negative_violated', 'H_* counts must be non-negative')
  if (counts.hUnique + counts.hR1 + counts.hUnresolved !== counts.hTotal) {
    throw new HCountError('h_counts_equality_violated', 'hUnique + hR1 + hUnresolved must equal hTotal')
  }
  if (counts.hSegment + counts.hProviderWord + counts.hAlignment !== counts.hUnique + counts.hR1) {
    throw new HCountError('h_counts_equality_violated', 'hSegment + hProviderWord + hAlignment must equal hUnique + hR1')
  }
  if (counts.hProviderWord !== 0) throw new HCountError('h_provider_word_nonzero', 'hProviderWord must be 0 in v2')
}

export const PUBLISH_BLOCK_CODES = [
  'publish_run_cancelled',
  'publish_incomplete_handoffs',
  'publish_unresolved_handoff',
  'publish_evidence_identity_mismatch',
  'publish_h_counts_inconsistent',
  'publish_h_unresolved_nonzero',
] as const
export type PublishBlockCode = (typeof PUBLISH_BLOCK_CODES)[number]

export class PublishBlockedError extends Error {
  constructor(
    readonly code: PublishBlockCode,
    message: string,
  ) {
    super(message)
    this.name = 'PublishBlockedError'
  }
}

export interface PublishAssertionInput {
  runCancelled: boolean
  activePlanRevision: number
  effectiveChunkCount: number
  handoffs: Array<{
    logicalHandoffIndex: number
    firstAcceptedRevision: 0 | 1
    expected: ExpectedEvidenceIdentity
    evidence: EvidenceIdentityView | null
  }>
}

/**
 * Pre-publish gate: every required handoff of the current effective
 * revision must carry exactly one accepted final evidence whose identity
 * matches, H_* must be consistent and hUnresolved must be 0.
 */
export function assertPublishable(input: PublishAssertionInput): HCounts {
  if (input.runCancelled) throw new PublishBlockedError('publish_run_cancelled', 'run is cancelled')
  if (input.activePlanRevision < 0 || input.activePlanRevision > MAX_AUTOMATIC_PLAN_REVISIONS) {
    throw new PublishBlockedError('publish_h_counts_inconsistent', 'active plan revision out of range')
  }

  const entries: HandoffCountEntry[] = []
  for (const handoff of input.handoffs) {
    if (handoff.evidence === null) {
      throw new PublishBlockedError('publish_incomplete_handoffs', `handoff ${handoff.logicalHandoffIndex} has no final evidence`)
    }
    try {
      validateEvidenceIdentity(handoff.evidence, handoff.expected)
    } catch (error) {
      if (error instanceof EvidenceValidationError) {
        throw new PublishBlockedError('publish_evidence_identity_mismatch', error.message)
      }
      throw error
    }
    if (handoff.evidence.decision !== 'accepted') {
      throw new PublishBlockedError('publish_unresolved_handoff', `handoff ${handoff.logicalHandoffIndex} is not accepted`)
    }
    entries.push({
      logicalHandoffIndex: handoff.logicalHandoffIndex,
      firstAcceptedRevision: handoff.firstAcceptedRevision,
      decision: handoff.evidence.decision,
      evidenceType: handoff.evidence.evidenceType,
    })
  }

  let counts: HCounts
  try {
    counts = recomputeHCounts(input.effectiveChunkCount, entries)
  } catch (error) {
    if (error instanceof HCountError) {
      throw new PublishBlockedError('publish_h_counts_inconsistent', error.message)
    }
    throw error
  }
  if (counts.hUnresolved !== 0) {
    throw new PublishBlockedError('publish_h_unresolved_nonzero', 'all handoffs must be resolved before publish')
  }
  return counts
}
