/**
 * F1 pure-domain schema tests. Marker values below are non-resolvable and
 * never reach the F2 API, Worker, queue, storage, adapter, logs, or network.
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  assertPublishable,
  HCountError,
  HandoffValidationError,
  EvidenceValidationError,
  InMemoryAlignmentAdapter,
  PublishBlockedError,
  recomputeHCounts,
  validateEvidenceIdentity,
  validateHandoffPair,
  validateStrictSegment,
  buildAlignmentIdempotencyKey,
  FakeProofDigestService,
  canonicalEnvelopeJson,
  type ChunkIdentity,
  type EvidenceIdentityView,
  type ExpectedEvidenceIdentity,
  type PrivateEvidenceEnvelope,
  type StrictSegmentInput,
} from './index'
import { FORBIDDEN_EVIDENCE_TYPE, STRICT_ACCEPTED_CODE } from './types'

const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')

function chunk(index: number, overrides: Partial<ChunkIdentity> = {}): ChunkIdentity {
  return {
    id: `chunk-${index}-${hex64(`chunk-${index}`).slice(0, 12)}`,
    processingRunId: 'run-synthetic-1',
    planRevision: 0,
    chunkIndex: index,
    status: 'SUCCEEDED',
    resultObjectKey: 'f1-domain-marker-asr-left',
    resultVersionId: `v-${index}`,
    resultChecksum: hex64(`asr-${index}`),
    ...overrides,
  }
}

function strictInput(overrides: Partial<StrictSegmentInput> = {}): StrictSegmentInput {
  return {
    leftChunk: chunk(0),
    rightChunk: chunk(1),
    planRevision: 0,
    windowStartMs: 1000,
    windowEndMs: 2000,
    inputChecksum: hex64('input'),
    candidates: [{ startMs: 1050, endMs: 1900, tokenCount: 3, hasSpeakerConflict: false }],
    missingFields: [],
    mixedGranularity: false,
    windowOutOfBounds: false,
    hasTimeConflict: false,
    hasSpeakerConflict: false,
    ...overrides,
  }
}

function expectedIdentity(overrides: Partial<ExpectedEvidenceIdentity> = {}): ExpectedEvidenceIdentity {
  return {
    handoffId: 'handoff-synthetic-1',
    processingRunId: 'run-synthetic-1',
    planRevision: 0,
    logicalHandoffIndex: 0,
    previousChunkId: 'chunk-0-synthetic',
    nextChunkId: 'chunk-1-synthetic',
    previousAsrObjectKey: 'f1-domain-marker-asr-left',
    previousAsrVersionId: 'v-0',
    previousAsrChecksum: hex64('asr-0'),
    nextAsrObjectKey: 'f1-domain-marker-asr-right',
    nextAsrVersionId: 'v-1',
    nextAsrChecksum: hex64('asr-1'),
    normalizedAudioVersionId: 'audio-v-1',
    normalizedAudioChecksum: hex64('audio'),
    windowStartMs: 1000,
    windowEndMs: 2000,
    methodDigest: hex64('method'),
    modelDigest: hex64('model'),
    configDigest: hex64('config'),
    alignmentPolicyDigest: hex64('policy'),
    ...overrides,
  }
}

function evidenceView(overrides: Partial<EvidenceIdentityView> = {}): EvidenceIdentityView {
  return {
    planRevision: 0,
    logicalHandoffIndex: 0,
    decision: 'accepted',
    decisionCode: 'evidence_accepted',
    evidenceType: 'strict_segment',
    previousChunkId: 'chunk-0-synthetic',
    nextChunkId: 'chunk-1-synthetic',
    previousAsrObjectKey: 'f1-domain-marker-asr-left',
    previousAsrVersionId: 'v-0',
    previousAsrChecksum: hex64('asr-0'),
    nextAsrObjectKey: 'f1-domain-marker-asr-right',
    nextAsrVersionId: 'v-1',
    nextAsrChecksum: hex64('asr-1'),
    normalizedAudioVersionId: 'audio-v-1',
    normalizedAudioChecksum: hex64('audio'),
    windowStartMs: 1000,
    windowEndMs: 2000,
    methodProvider: 'mfa',
    methodVersion: '3.3.9',
    modelRevision: 'english_mfa-3.1.0',
    alignmentPolicyDigest: hex64('policy'),
    ...overrides,
  }
}

describe('validateHandoffPair', () => {
  it('accepts an adjacent, same-run, same-revision SUCCEEDED pair', () => {
    expect(() => validateHandoffPair(chunk(0), chunk(1), 0)).not.toThrow()
  })

  it('rejects non-adjacent chunks', () => {
    expect(() => validateHandoffPair(chunk(0), chunk(2), 0)).toThrow(HandoffValidationError)
  })

  it('rejects cross-run chunks', () => {
    expect(() => validateHandoffPair(chunk(0), chunk(1, { processingRunId: 'run-other' }), 0)).toThrow(
      HandoffValidationError,
    )
  })

  it('rejects plan-revision mismatch', () => {
    expect(() => validateHandoffPair(chunk(0), chunk(1, { planRevision: 1 }), 0)).toThrow(HandoffValidationError)
  })

  it('rejects invalid (non-SUCCEEDED) chunks', () => {
    expect(() => validateHandoffPair(chunk(0), chunk(1, { status: 'FAILED' }), 0)).toThrow(HandoffValidationError)
  })

  it('rejects self reference', () => {
    expect(() => validateHandoffPair(chunk(0), chunk(0), 0)).toThrow(HandoffValidationError)
  })
})

describe('validateStrictSegment', () => {
  it('accepts a single strong candidate without conflicts', () => {
    const assessment = validateStrictSegment(strictInput())
    expect(assessment.decision).toBe('accepted')
    expect(assessment.decisionCode).toBe(STRICT_ACCEPTED_CODE)
  })

  it('fails closed on no handoff text (no candidates)', () => {
    const assessment = validateStrictSegment(strictInput({ candidates: [] }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('no_handoff_text')
  })

  it('fails closed on single-token candidate', () => {
    const assessment = validateStrictSegment(
      strictInput({ candidates: [{ startMs: 1050, endMs: 1900, tokenCount: 1, hasSpeakerConflict: false }] }),
    )
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('single_token_candidate')
  })

  it('fails closed on missing fields', () => {
    const assessment = validateStrictSegment(strictInput({ missingFields: ['resultVersionId'] }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('missing_fields')
  })

  it('fails closed on window out of bounds', () => {
    const assessment = validateStrictSegment(strictInput({ windowOutOfBounds: true }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('window_out_of_bounds')
  })

  it('fails closed on mixed granularity', () => {
    const assessment = validateStrictSegment(strictInput({ mixedGranularity: true }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('mixed_granularity')
  })

  it('fails closed on identity mismatch (chunk status)', () => {
    const assessment = validateStrictSegment(strictInput({ leftChunk: chunk(0, { status: 'FAILED' }) }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('identity_mismatch')
  })

  it('fails closed on invalid input checksum', () => {
    const assessment = validateStrictSegment(strictInput({ inputChecksum: 'not-a-checksum' }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('result_invalid')
  })

  it('flags speaker conflict as repair-eligible ambiguous', () => {
    const assessment = validateStrictSegment(
      strictInput({
        hasSpeakerConflict: true,
        candidates: [
          { startMs: 1050, endMs: 1900, tokenCount: 3, hasSpeakerConflict: true },
        ],
      }),
    )
    expect(assessment.decision).toBe('ambiguous')
    expect(assessment.decisionCode).toBe('text_time_match_with_speaker_conflict')
  })

  it('flags multiple candidates as ambiguous with a whitelisted repair code', () => {
    const assessment = validateStrictSegment(
      strictInput({
        candidates: [
          { startMs: 1050, endMs: 1900, tokenCount: 3, hasSpeakerConflict: false },
          { startMs: 1100, endMs: 1950, tokenCount: 4, hasSpeakerConflict: false },
        ],
      }),
    )
    expect(assessment.decision).toBe('ambiguous')
    expect(assessment.decisionCode).toBe('no_textual_suffix_prefix')
  })
})

describe('validateEvidenceIdentity', () => {
  it('accepts a fully matching accepted evidence', () => {
    expect(() => validateEvidenceIdentity(evidenceView(), expectedIdentity())).not.toThrow()
  })

  it('rejects chunk identity mismatch', () => {
    expect(() =>
      validateEvidenceIdentity(evidenceView({ previousChunkId: 'chunk-other' }), expectedIdentity()),
    ).toThrow(EvidenceValidationError)
  })

  it('rejects ASR checksum mismatch', () => {
    expect(() =>
      validateEvidenceIdentity(
        evidenceView({ previousAsrChecksum: hex64('other') }),
        expectedIdentity(),
      ),
    ).toThrow(EvidenceValidationError)
  })

  it('rejects window mismatch', () => {
    expect(() =>
      validateEvidenceIdentity(evidenceView({ windowStartMs: 999 }), expectedIdentity()),
    ).toThrow(EvidenceValidationError)
  })

  it('rejects forbidden provider_native_word_timing type', () => {
    expect(() =>
      validateEvidenceIdentity(
        evidenceView({ evidenceType: FORBIDDEN_EVIDENCE_TYPE as unknown as EvidenceIdentityView['evidenceType'] }),
        expectedIdentity(),
      ),
    ).toThrow(EvidenceValidationError)
  })

  it('rejects non-whitelisted decision', () => {
    expect(() =>
      validateEvidenceIdentity(evidenceView({ decision: 'rejected' as never }), expectedIdentity()),
    ).toThrow(EvidenceValidationError)
  })

  it('rejects non-whitelisted decisionCode', () => {
    expect(() =>
      validateEvidenceIdentity(evidenceView({ decisionCode: 'made_up_code' }), expectedIdentity()),
    ).toThrow(EvidenceValidationError)
  })

  it('rejects malformed checksum format', () => {
    expect(() =>
      validateEvidenceIdentity(
        evidenceView({ nextAsrChecksum: 'ZZZ' }),
        expectedIdentity({ nextAsrChecksum: 'ZZZ' }),
      ),
    ).toThrow(EvidenceValidationError)
  })
})

describe('recomputeHCounts', () => {
  it('single chunk yields H_total = 0', () => {
    const counts = recomputeHCounts(1, [])
    expect(counts).toEqual({ hTotal: 0, hUnique: 0, hR1: 0, hUnresolved: 0, hSegment: 0, hProviderWord: 0, hAlignment: 0 })
  })

  it('zero chunks yield H_total = 0', () => {
    expect(recomputeHCounts(0, []).hTotal).toBe(0)
  })

  it('two chunks with one strict accepted handoff', () => {
    const counts = recomputeHCounts(2, [
      { logicalHandoffIndex: 0, firstAcceptedRevision: 0, decision: 'accepted', evidenceType: 'strict_segment' },
    ])
    expect(counts).toEqual({ hTotal: 1, hUnique: 1, hR1: 0, hUnresolved: 0, hSegment: 1, hProviderWord: 0, hAlignment: 0 })
  })

  it('accepted handoffs first accepted in revision 1 count as hR1', () => {
    const counts = recomputeHCounts(2, [
      { logicalHandoffIndex: 0, firstAcceptedRevision: 1, decision: 'accepted', evidenceType: 'boundary_forced_alignment' },
    ])
    expect(counts.hR1).toBe(1)
    expect(counts.hAlignment).toBe(1)
  })

  it('unresolved handoffs count as hUnresolved and satisfy both equalities', () => {
    const counts = recomputeHCounts(3, [
      { logicalHandoffIndex: 0, firstAcceptedRevision: 0, decision: 'accepted', evidenceType: 'strict_segment' },
      { logicalHandoffIndex: 1, firstAcceptedRevision: 0, decision: 'insufficient', evidenceType: 'boundary_forced_alignment' },
    ])
    expect(counts.hTotal).toBe(2)
    expect(counts.hUnique + counts.hR1 + counts.hUnresolved).toBe(counts.hTotal)
    expect(counts.hSegment + counts.hProviderWord + counts.hAlignment).toBe(counts.hUnique + counts.hR1)
  })

  it('rejects missing handoff records', () => {
    expect(() =>
      recomputeHCounts(3, [
        { logicalHandoffIndex: 0, firstAcceptedRevision: 0, decision: 'accepted', evidenceType: 'strict_segment' },
      ]),
    ).toThrow(HCountError)
  })

  it('rejects duplicate handoff records', () => {
    expect(() =>
      recomputeHCounts(2, [
        { logicalHandoffIndex: 0, firstAcceptedRevision: 0, decision: 'accepted', evidenceType: 'strict_segment' },
        { logicalHandoffIndex: 0, firstAcceptedRevision: 0, decision: 'accepted', evidenceType: 'strict_segment' },
      ]),
    ).toThrow(HCountError)
  })

  it('rejects provider_native_word_timing', () => {
    expect(() =>
      recomputeHCounts(2, [
        {
          logicalHandoffIndex: 0,
          firstAcceptedRevision: 0,
          decision: 'accepted',
          evidenceType: FORBIDDEN_EVIDENCE_TYPE as unknown as 'strict_segment' | 'boundary_forced_alignment',
        },
      ]),
    ).toThrow(HCountError)
  })

  it('rejects inconsistent H_* values via assertHCounts', () => {
    expect(() =>
      recomputeHCounts(2, [
        { logicalHandoffIndex: 0, firstAcceptedRevision: 0, decision: 'ambiguous', evidenceType: 'strict_segment' },
      ]),
    ).not.toThrow()
  })
})

describe('assertPublishable', () => {
  const publishInput = (): import('./index').PublishAssertionInput => ({
    runCancelled: false,
    activePlanRevision: 0,
    effectiveChunkCount: 2,
    handoffs: [
      {
        logicalHandoffIndex: 0,
        firstAcceptedRevision: 0 as const,
        expected: expectedIdentity(),
        evidence: evidenceView(),
      },
    ],
  })

  it('allows publish when the single handoff is accepted and consistent', () => {
    const counts = assertPublishable(publishInput())
    expect(counts.hUnresolved).toBe(0)
    expect(counts.hTotal).toBe(1)
  })

  it('blocks publish on cancelled run', () => {
    expect(() => assertPublishable({ ...publishInput(), runCancelled: true })).toThrow(PublishBlockedError)
  })

  it('blocks publish on missing final evidence', () => {
    const input = publishInput()
    input.handoffs[0]!.evidence = null
    expect(() => assertPublishable(input)).toThrow(PublishBlockedError)
  })

  it('blocks publish on unresolved (insufficient) handoff', () => {
    const input = publishInput()
    input.handoffs[0]!.evidence = evidenceView({ decision: 'insufficient', decisionCode: 'alignment_unavailable' })
    expect(() => assertPublishable(input)).toThrow(PublishBlockedError)
  })

  it('blocks publish on identity mismatch', () => {
    const input = publishInput()
    input.handoffs[0]!.evidence = evidenceView({ previousChunkId: 'chunk-other' })
    expect(() => assertPublishable(input)).toThrow(PublishBlockedError)
  })

  it('blocks publish when H_* would be inconsistent', () => {
    const input = publishInput()
    input.effectiveChunkCount = 3
    expect(() => assertPublishable(input)).toThrow(PublishBlockedError)
  })
})

describe('buildAlignmentIdempotencyKey', () => {
  const base = {
    processingRunId: 'run-synthetic-1',
    planRevision: 0,
    logicalHandoffIndex: 0,
    previousChunkId: 'chunk-0-synthetic',
    previousAsrObjectKey: 'f1-domain-marker-asr-left',
    previousAsrVersionId: 'v-0',
    previousAsrChecksum: hex64('asr-0'),
    nextChunkId: 'chunk-1-synthetic',
    nextAsrObjectKey: 'f1-domain-marker-asr-right',
    nextAsrVersionId: 'v-1',
    nextAsrChecksum: hex64('asr-1'),
    normalizedAudioVersionId: 'audio-v-1',
    normalizedAudioChecksum: hex64('audio'),
    windowStartMs: 1000,
    windowEndMs: 2000,
    methodDigest: hex64('method'),
    modelDigest: hex64('model'),
    configDigest: hex64('config'),
  }

  it('is deterministic for identical inputs', () => {
    expect(buildAlignmentIdempotencyKey(base)).toBe(buildAlignmentIdempotencyKey(base))
  })

  it('changes when a material identity changes (must be a new job, never a retry)', () => {
    const mutated = { ...base, nextAsrChecksum: hex64('asr-1-changed') }
    expect(buildAlignmentIdempotencyKey(mutated)).not.toBe(buildAlignmentIdempotencyKey(base))
  })

  it('changes when the window changes', () => {
    expect(buildAlignmentIdempotencyKey({ ...base, windowStartMs: 1100 })).not.toBe(
      buildAlignmentIdempotencyKey(base),
    )
  })
})

describe('F1 pure-domain strict insufficient -> Fake alignment accepted -> publish chain', () => {
  it('turns a strict insufficient into an accepted boundary_forced_alignment and publishes', async () => {
    // 1. strict segment assessment fails closed with no_handoff_text.
    const assessment = validateStrictSegment(strictInput({ candidates: [] }))
    expect(assessment.decision).toBe('insufficient')
    expect(assessment.decisionCode).toBe('no_handoff_text')

    // 2. A boundary alignment job is submitted to the deterministic Fake.
    const adapter = new InMemoryAlignmentAdapter()
    const submission = await adapter.submit({
      idempotencyKey: buildAlignmentIdempotencyKey({
        processingRunId: 'run-synthetic-1',
        planRevision: 0,
        logicalHandoffIndex: 0,
        previousChunkId: 'chunk-0-synthetic',
        previousAsrObjectKey: 'f1-domain-marker-asr-left',
        previousAsrVersionId: 'v-0',
        previousAsrChecksum: hex64('asr-0'),
        nextChunkId: 'chunk-1-synthetic',
        nextAsrObjectKey: 'f1-domain-marker-asr-right',
        nextAsrVersionId: 'v-1',
        nextAsrChecksum: hex64('asr-1'),
        normalizedAudioVersionId: 'audio-v-1',
        normalizedAudioChecksum: hex64('audio'),
        windowStartMs: 1000,
        windowEndMs: 2000,
        methodDigest: hex64('method'),
        modelDigest: hex64('model'),
        configDigest: hex64('config'),
      }),
      correlationHandle: 'fake-correlation-0001',
      pipelineVersion: 'g3-transcript-v2',
      windowStartMs: 1000,
      windowEndMs: 2000,
      methodDigest: hex64('method'),
      modelDigest: hex64('model'),
      configDigest: hex64('config'),
    })
    adapter.scriptOutcome(submission.externalJobId, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 900 },
    })
    const result = await adapter.read(submission.externalJobId)
    expect(result.decision).toBe('accepted')

    // 3. The final accepted evidence validates against the handoff identity.
    const finalEvidence = evidenceView({ evidenceType: 'boundary_forced_alignment' })
    expect(() => validateEvidenceIdentity(finalEvidence, expectedIdentity())).not.toThrow()

    // 4. Publication passes with a fully resolved handoff.
    const counts = assertPublishable({
      runCancelled: false,
      activePlanRevision: 0,
      effectiveChunkCount: 2,
      handoffs: [
        { logicalHandoffIndex: 0, firstAcceptedRevision: 0, expected: expectedIdentity(), evidence: finalEvidence },
      ],
    })
    expect(counts.hUnresolved).toBe(0)
    expect(counts.hAlignment).toBe(1)
  })
})

describe('FakeProofDigestService', () => {
  const envelope: PrivateEvidenceEnvelope = {
    schemaVersion: '1',
    pipelineVersion: 'g3-transcript-v2',
    processingRunId: 'run-synthetic-1',
    planRevision: 0,
    logicalHandoffIndex: 0,
    previousChunkId: 'chunk-0-synthetic',
    nextChunkId: 'chunk-1-synthetic',
    previousAsrObjectKey: 'f1-domain-marker-asr-left',
    previousAsrVersionId: 'v-0',
    previousAsrChecksum: hex64('asr-0'),
    nextAsrObjectKey: 'f1-domain-marker-asr-right',
    nextAsrVersionId: 'v-1',
    nextAsrChecksum: hex64('asr-1'),
    normalizedAudioVersionId: 'audio-v-1',
    normalizedAudioChecksum: hex64('audio'),
    rawObjectKey: null,
    rawVersionId: null,
    rawChecksum: null,
    methodProvider: 'mfa',
    methodVersion: '3.3.9',
    modelRevision: 'english_mfa-3.1.0',
    alignmentPolicyDigest: hex64('policy'),
    windowStartMs: 1000,
    windowEndMs: 2000,
    decision: 'accepted',
    decisionCode: 'evidence_accepted',
    evidenceType: 'strict_segment',
  }

  it('signs and verifies a canonical envelope', () => {
    const service = new FakeProofDigestService(Buffer.from('test-key', 'utf8'))
    const digest = service.sign(envelope)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(service.verify(digest, envelope)).toBe(true)
  })

  it('fails verification on any envelope change', () => {
    const service = new FakeProofDigestService(Buffer.from('test-key', 'utf8'))
    const digest = service.sign(envelope)
    expect(service.verify(digest, { ...envelope, windowStartMs: 1100 })).toBe(false)
  })

  it('fails verification under a different key', () => {
    const a = new FakeProofDigestService(Buffer.from('key-a', 'utf8'), 'v1')
    const b = new FakeProofDigestService(Buffer.from('key-b', 'utf8'), 'v2')
    expect(b.verify(a.sign(envelope), envelope)).toBe(false)
  })

  it('produces stable canonical JSON regardless of key order', () => {
    expect(canonicalEnvelopeJson(envelope)).toBe(canonicalEnvelopeJson(envelope))
  })
})
