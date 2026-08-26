/**
 * G3 v2 HANDOFF_EVIDENCING orchestration core.
 *
 * Pure, deterministic, NON-CONTENT: it turns a strict assessment (or an
 * alignment result from the injected AlignmentAdapter) into a final
 * `HandoffEvidence` view, then signs a proof digest over a canonical,
 * non-content identity envelope. It never touches the database, media,
 * object storage or network — the v2 processor drives the DB lifecycle
 * around these functions.
 */

import {
  SCHEMA_VERSION,
  PIPELINE_VERSION_V2,
  STRICT_ACCEPTED_CODE,
  EVIDENCE_ACCEPTED_CODE,
  ALIGNMENT_INSUFFICIENT_CODES,
  type ChunkIdentity,
  type EvidenceType,
  type HandoffDecision,
  type StrictAssessment,
  type StrictSegmentInput,
} from './types'
import {
  validateEvidenceIdentity,
  type EvidenceIdentityView,
  type ExpectedEvidenceIdentity,
} from './validators'
import {
  canonicalEnvelopeJson,
  type ProofDigestService,
  type PrivateEvidenceEnvelope,
} from './proof'
import type { AlignmentResultView } from './alignment'

/** Chunk view used to assemble a handoff: identity + boundary window only. */
export interface HandoffChunkView extends ChunkIdentity {
  startMs: number
  endMs: number
}

/**
 * Injectable strict-assessment input builder. F2 authorizes an injected Fake
 * only: it assembles `StrictSegmentInput` from NON-CONTENT chunk identity and
 * window bounds — never reading subtitle text, tokens, word timings, audio
 * bytes, raw provider results, object keys/URLs or any secret.
 */
export interface StrictAssessmentInputProvider {
  build(previous: HandoffChunkView, next: HandoffChunkView, planRevision: number): StrictSegmentInput
}

export type ScriptedStrictOutcome =
  | { kind: 'accepted' }
  | { kind: 'insufficient'; decisionCode: string }
  | { kind: 'ambiguous'; decisionCode: string }

/**
 * Deterministic Fake provider. By default every handoff is a strong accepted
 * segment; individual handoff indices can be scripted to insufficient or
 * ambiguous outcomes so the alignment / failure-close paths are testable.
 */
export class FakeStrictAssessmentInputProvider implements StrictAssessmentInputProvider {
  private readonly scripts = new Map<number, ScriptedStrictOutcome>()

  script(handoffIndex: number, outcome: ScriptedStrictOutcome): void {
    this.scripts.set(handoffIndex, outcome)
  }

  build(previous: HandoffChunkView, next: HandoffChunkView, planRevision: number): StrictSegmentInput {
    const handoffIndex = next.chunkIndex - 1
    const windowStartMs = Math.min(previous.endMs, next.startMs)
    const windowEndMs = Math.max(previous.endMs, next.startMs) || windowStartMs + 1
    const scripted = this.scripts.get(handoffIndex)
    if (!scripted || scripted.kind === 'accepted') {
      return {
        leftChunk: previous,
        rightChunk: next,
        planRevision,
        windowStartMs,
        windowEndMs,
        inputChecksum: '0'.repeat(64),
        candidates: [{ startMs: windowStartMs, endMs: windowEndMs, tokenCount: 2, hasSpeakerConflict: false }],
        missingFields: [],
        mixedGranularity: false,
        windowOutOfBounds: false,
        hasTimeConflict: false,
        hasSpeakerConflict: false,
      }
    }
    if (scripted.kind === 'insufficient') {
      return {
        leftChunk: previous,
        rightChunk: next,
        planRevision,
        windowStartMs,
        windowEndMs,
        inputChecksum: '0'.repeat(64),
        candidates: [],
        missingFields: [],
        mixedGranularity: false,
        windowOutOfBounds: false,
        hasTimeConflict: false,
        hasSpeakerConflict: false,
      }
    }
    // ambiguous: two strong candidates with no unique boundary signal.
    return {
      leftChunk: previous,
      rightChunk: next,
      planRevision,
      windowStartMs,
      windowEndMs,
      inputChecksum: '0'.repeat(64),
      candidates: [
        { startMs: windowStartMs, endMs: windowEndMs, tokenCount: 2, hasSpeakerConflict: false },
        { startMs: windowStartMs, endMs: windowEndMs, tokenCount: 2, hasSpeakerConflict: false },
      ],
      missingFields: [],
      mixedGranularity: false,
      windowOutOfBounds: false,
      hasTimeConflict: false,
      hasSpeakerConflict: false,
    }
  }
}

/** Complete final-evidence record (maps 1:1 onto HandoffEvidence columns). */
export interface MaterializedEvidence {
  planRevision: number
  logicalHandoffIndex: number
  decision: HandoffDecision
  decisionCode: string
  evidenceType: EvidenceType
  schemaVersion: string
  pipelineVersion: string
  previousChunkId: string
  nextChunkId: string
  normalizedAudioVersionId: string | null
  normalizedAudioChecksum: string | null
  previousAsrObjectKey: string
  previousAsrVersionId: string | null
  previousAsrChecksum: string | null
  nextAsrObjectKey: string
  nextAsrVersionId: string | null
  nextAsrChecksum: string | null
  rawObjectKey: string | null
  rawVersionId: string | null
  rawChecksum: string | null
  methodProvider: string
  methodVersion: string
  modelRevision: string | null
  alignmentPolicyDigest: string | null
  windowStartMs: number
  windowEndMs: number
  candidateCount: number
  anchorCount: number
  coverageMs: number
  proofKeyVersion: string
  proofDigest: string
}

export interface AlignmentResolutionInput {
  expected: ExpectedEvidenceIdentity
  result: AlignmentResultView
  raw: { objectKey: string; versionId: string; checksum: string }
  proof: ProofDigestService
  methodProvider: string
  methodVersion: string
  modelRevision: string | null
}

export type HandoffResolution =
  | { kind: 'accepted'; evidence: MaterializedEvidence }
  | { kind: 'rejected'; reason: 'ambiguous' | 'insufficient'; decisionCode: string }
  | { kind: 'needs_alignment'; decisionCode: string }

/** Resolve a strict assessment: accepted -> strict_segment evidence. */
export function resolveStrictHandoff(
  expected: ExpectedEvidenceIdentity,
  strict: StrictAssessment,
  proof: ProofDigestService,
): HandoffResolution {
  if (strict.decision === 'accepted') {
    return {
      kind: 'accepted',
      evidence: buildStrictSegmentEvidence(expected, strict, proof),
    }
  }
  if (strict.decision === 'ambiguous') {
    return { kind: 'rejected', reason: 'ambiguous', decisionCode: strict.decisionCode }
  }
  return { kind: 'needs_alignment', decisionCode: strict.decisionCode }
}

/** Resolve an alignment result: accepted -> boundary_forced_alignment evidence. */
export function resolveAlignmentHandoff(input: AlignmentResolutionInput): HandoffResolution {
  if (input.result.decision === 'accepted') {
    return {
      kind: 'accepted',
      evidence: buildAlignmentEvidence(input),
    }
  }
  const decisionCode = (ALIGNMENT_INSUFFICIENT_CODES as readonly string[]).includes(input.result.decisionCode)
    ? input.result.decisionCode
    : 'alignment_result_invalid'
  return { kind: 'rejected', reason: 'insufficient', decisionCode }
}

/** Build a strict_segment final evidence (candidateCount=1, no raw). */
export function buildStrictSegmentEvidence(
  expected: ExpectedEvidenceIdentity,
  strict: StrictAssessment,
  proof: ProofDigestService,
): MaterializedEvidence {
  return assembleEvidence(
    expected,
    {
      decision: 'accepted',
      decisionCode: EVIDENCE_ACCEPTED_CODE,
      evidenceType: 'strict_segment',
      candidateCount: 1,
      anchorCount: 0,
      coverageMs: 0,
      raw: null,
      methodProvider: 'strict_segment',
      methodVersion: SCHEMA_VERSION,
      modelRevision: null,
    },
    proof,
  )
}

/** Build a boundary_forced_alignment final evidence from an alignment result. */
export function buildAlignmentEvidence(input: AlignmentResolutionInput): MaterializedEvidence {
  return assembleEvidence(
    input.expected,
    {
      decision: 'accepted',
      decisionCode: EVIDENCE_ACCEPTED_CODE,
      evidenceType: 'boundary_forced_alignment',
      candidateCount: input.result.candidateCount,
      anchorCount: input.result.anchorCount,
      coverageMs: input.result.coverageMs,
      raw: input.raw,
      methodProvider: input.methodProvider,
      methodVersion: input.methodVersion,
      modelRevision: input.modelRevision,
    },
    input.proof,
  )
}

interface EvidenceAssembly {
  decision: HandoffDecision
  decisionCode: string
  evidenceType: EvidenceType
  candidateCount: number
  anchorCount: number
  coverageMs: number
  raw: { objectKey: string; versionId: string; checksum: string } | null
  methodProvider: string
  methodVersion: string
  modelRevision: string | null
}

function assembleEvidence(expected: ExpectedEvidenceIdentity, assembly: EvidenceAssembly, proof: ProofDigestService): MaterializedEvidence {
  const identityView: EvidenceIdentityView = {
    planRevision: expected.planRevision,
    logicalHandoffIndex: expected.logicalHandoffIndex,
    decision: assembly.decision,
    decisionCode: assembly.decisionCode,
    evidenceType: assembly.evidenceType,
    previousChunkId: expected.previousChunkId,
    nextChunkId: expected.nextChunkId,
    previousAsrObjectKey: expected.previousAsrObjectKey,
    previousAsrVersionId: expected.previousAsrVersionId,
    previousAsrChecksum: expected.previousAsrChecksum,
    nextAsrObjectKey: expected.nextAsrObjectKey,
    nextAsrVersionId: expected.nextAsrVersionId,
    nextAsrChecksum: expected.nextAsrChecksum,
    normalizedAudioVersionId: expected.normalizedAudioVersionId,
    normalizedAudioChecksum: expected.normalizedAudioChecksum,
    windowStartMs: expected.windowStartMs,
    windowEndMs: expected.windowEndMs,
    methodProvider: assembly.methodProvider,
    methodVersion: assembly.methodVersion,
    modelRevision: assembly.modelRevision,
    alignmentPolicyDigest: expected.alignmentPolicyDigest ?? null,
  }
  validateEvidenceIdentity(identityView, expected)

  const envelope: PrivateEvidenceEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION_V2,
    processingRunId: expected.processingRunId,
    planRevision: expected.planRevision,
    logicalHandoffIndex: expected.logicalHandoffIndex,
    previousChunkId: expected.previousChunkId,
    nextChunkId: expected.nextChunkId,
    previousAsrObjectKey: expected.previousAsrObjectKey,
    previousAsrVersionId: expected.previousAsrVersionId,
    previousAsrChecksum: expected.previousAsrChecksum,
    nextAsrObjectKey: expected.nextAsrObjectKey,
    nextAsrVersionId: expected.nextAsrVersionId,
    nextAsrChecksum: expected.nextAsrChecksum,
    normalizedAudioVersionId: expected.normalizedAudioVersionId,
    normalizedAudioChecksum: expected.normalizedAudioChecksum,
    rawObjectKey: assembly.raw?.objectKey ?? null,
    rawVersionId: assembly.raw?.versionId ?? null,
    rawChecksum: assembly.raw?.checksum ?? null,
    methodProvider: assembly.methodProvider,
    methodVersion: assembly.methodVersion,
    modelRevision: assembly.modelRevision,
    alignmentPolicyDigest: expected.alignmentPolicyDigest ?? null,
    windowStartMs: expected.windowStartMs,
    windowEndMs: expected.windowEndMs,
    decision: assembly.decision,
    decisionCode: assembly.decisionCode,
    evidenceType: assembly.evidenceType,
  }

  return {
    planRevision: identityView.planRevision,
    logicalHandoffIndex: identityView.logicalHandoffIndex,
    decision: identityView.decision,
    decisionCode: identityView.decisionCode,
    evidenceType: identityView.evidenceType,
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION_V2,
    previousChunkId: identityView.previousChunkId,
    nextChunkId: identityView.nextChunkId,
    normalizedAudioVersionId: identityView.normalizedAudioVersionId,
    normalizedAudioChecksum: identityView.normalizedAudioChecksum,
    previousAsrObjectKey: identityView.previousAsrObjectKey,
    previousAsrVersionId: identityView.previousAsrVersionId,
    previousAsrChecksum: identityView.previousAsrChecksum,
    nextAsrObjectKey: identityView.nextAsrObjectKey,
    nextAsrVersionId: identityView.nextAsrVersionId,
    nextAsrChecksum: identityView.nextAsrChecksum,
    rawObjectKey: assembly.raw?.objectKey ?? null,
    rawVersionId: assembly.raw?.versionId ?? null,
    rawChecksum: assembly.raw?.checksum ?? null,
    methodProvider: assembly.methodProvider,
    methodVersion: assembly.methodVersion,
    modelRevision: assembly.modelRevision,
    alignmentPolicyDigest: identityView.alignmentPolicyDigest,
    windowStartMs: identityView.windowStartMs,
    windowEndMs: identityView.windowEndMs,
    candidateCount: assembly.candidateCount,
    anchorCount: assembly.anchorCount,
    coverageMs: assembly.coverageMs,
    proofKeyVersion: proof.keyVersion,
    proofDigest: proof.sign(envelope),
  }
}

export { canonicalEnvelopeJson }
export { STRICT_ACCEPTED_CODE }
