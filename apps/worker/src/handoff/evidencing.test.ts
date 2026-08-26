import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  FakeProofDigestService,
  FakeStrictAssessmentInputProvider,
  resolveAlignmentHandoff,
  resolveStrictHandoff,
  validateStrictSegment,
  type ChunkIdentity,
  type ExpectedEvidenceIdentity,
  type HandoffChunkView,
  type StrictSegmentInput,
} from './index'

const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')
const proof = new FakeProofDigestService(Buffer.from('evidencing-test-key'), 'test-v1')

function chunk(index: number, overrides: Partial<ChunkIdentity> = {}): ChunkIdentity {
  return {
    id: `chunk-${index}`,
    processingRunId: 'run-1',
    planRevision: 0,
    chunkIndex: index,
    status: 'SUCCEEDED',
    resultObjectKey: `asr://${index}`,
    resultVersionId: `v-${index}`,
    resultChecksum: hex64(`asr-${index}`),
    ...overrides,
  }
}

function chunkView(index: number, startMs: number, endMs: number): HandoffChunkView {
  return { ...chunk(index), startMs, endMs }
}

function expectedIdentity(): ExpectedEvidenceIdentity {
  return {
    handoffId: 'handoff-1',
    processingRunId: 'run-1',
    planRevision: 0,
    logicalHandoffIndex: 0,
    previousChunkId: 'chunk-0',
    nextChunkId: 'chunk-1',
    previousAsrObjectKey: 'asr://0',
    previousAsrVersionId: 'v-0',
    previousAsrChecksum: hex64('asr-0'),
    nextAsrObjectKey: 'asr://1',
    nextAsrVersionId: 'v-1',
    nextAsrChecksum: hex64('asr-1'),
    normalizedAudioVersionId: 'audio-v-1',
    normalizedAudioChecksum: hex64('audio'),
    windowStartMs: 900,
    windowEndMs: 1100,
    methodDigest: hex64('method'),
    modelDigest: hex64('model'),
    configDigest: hex64('config'),
    alignmentPolicyDigest: hex64('policy'),
  }
}

function acceptedStrictInput(): StrictSegmentInput {
  return {
    leftChunk: chunk(0),
    rightChunk: chunk(1),
    planRevision: 0,
    windowStartMs: 900,
    windowEndMs: 1100,
    inputChecksum: '0'.repeat(64),
    candidates: [{ startMs: 950, endMs: 1050, tokenCount: 2, hasSpeakerConflict: false }],
    missingFields: [],
    mixedGranularity: false,
    windowOutOfBounds: false,
    hasTimeConflict: false,
    hasSpeakerConflict: false,
  }
}

describe('FakeStrictAssessmentInputProvider', () => {
  it('defaults to a strong accepted segment', () => {
    const provider = new FakeStrictAssessmentInputProvider()
    const input = provider.build(chunkView(0, 0, 1000), chunkView(1, 900, 2000), 0)
    expect(input.candidates.length).toBe(1)
    expect(validateStrictSegment(input).decision).toBe('accepted')
  })

  it('can be scripted to insufficient (empty candidates)', () => {
    const provider = new FakeStrictAssessmentInputProvider()
    provider.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const input = provider.build(chunkView(0, 0, 1000), chunkView(1, 900, 2000), 0)
    expect(input.candidates.length).toBe(0)
    expect(validateStrictSegment(input).decision).toBe('insufficient')
  })

  it('can be scripted to ambiguous (two strong candidates)', () => {
    const provider = new FakeStrictAssessmentInputProvider()
    provider.script(0, { kind: 'ambiguous', decisionCode: 'multiple_valid_alignments' })
    const input = provider.build(chunkView(0, 0, 1000), chunkView(1, 900, 2000), 0)
    expect(validateStrictSegment(input).decision).toBe('ambiguous')
  })
})

describe('resolveStrictHandoff', () => {
  it('accepted -> strict_segment evidence with a verifiable proof digest', () => {
    const strict = validateStrictSegment(acceptedStrictInput())
    const resolution = resolveStrictHandoff(expectedIdentity(), strict, proof)
    expect(resolution.kind).toBe('accepted')
    if (resolution.kind !== 'accepted') return
    expect(resolution.evidence.evidenceType).toBe('strict_segment')
    expect(resolution.evidence.decision).toBe('accepted')
    expect(resolution.evidence.candidateCount).toBe(1)
    expect(resolution.evidence.rawObjectKey).toBeNull()
    expect(resolution.evidence.proofDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('ambiguous -> rejected with reason ambiguous', () => {
    const strict = validateStrictSegment({
      ...acceptedStrictInput(),
      candidates: [
        { startMs: 950, endMs: 1050, tokenCount: 2, hasSpeakerConflict: false },
        { startMs: 950, endMs: 1050, tokenCount: 2, hasSpeakerConflict: false },
      ],
    })
    const resolution = resolveStrictHandoff(expectedIdentity(), strict, proof)
    expect(resolution.kind).toBe('rejected')
    if (resolution.kind !== 'rejected') return
    expect(resolution.reason).toBe('ambiguous')
  })

  it('insufficient -> needs_alignment', () => {
    const strict = validateStrictSegment({ ...acceptedStrictInput(), candidates: [] })
    const resolution = resolveStrictHandoff(expectedIdentity(), strict, proof)
    expect(resolution.kind).toBe('needs_alignment')
  })
})

describe('resolveAlignmentHandoff', () => {
  const raw = { objectKey: 'raw-sentinel', versionId: 'raw-sentinel-v1', checksum: '0'.repeat(64) }

  it('accepted -> boundary_forced_alignment evidence with raw identity', () => {
    const resolution = resolveAlignmentHandoff({
      expected: expectedIdentity(),
      result: { externalJobId: 'fake-1', decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 200 },
      raw,
      proof,
      methodProvider: 'mfa',
      methodVersion: '3.3.9',
      modelRevision: 'english_mfa-3.1.0',
    })
    expect(resolution.kind).toBe('accepted')
    if (resolution.kind !== 'accepted') return
    expect(resolution.evidence.evidenceType).toBe('boundary_forced_alignment')
    expect(resolution.evidence.anchorCount).toBe(2)
    expect(resolution.evidence.rawObjectKey).toBe('raw-sentinel')
    expect(resolution.evidence.rawChecksum).toBe('0'.repeat(64))
  })

  it('insufficient -> rejected', () => {
    const resolution = resolveAlignmentHandoff({
      expected: expectedIdentity(),
      result: { externalJobId: 'fake-2', decision: 'insufficient', decisionCode: 'alignment_timeout', candidateCount: 0, anchorCount: 0, coverageMs: 0 },
      raw,
      proof,
      methodProvider: 'mfa',
      methodVersion: '3.3.9',
      modelRevision: 'english_mfa-3.1.0',
    })
    expect(resolution.kind).toBe('rejected')
    if (resolution.kind !== 'rejected') return
    expect(resolution.reason).toBe('insufficient')
  })
})
