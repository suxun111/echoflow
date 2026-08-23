import { describe, expect, it } from 'vitest'
import { buildTranscript, mergeChunkResults, segmentTranscript, TranscriptValidationError } from './merge'

describe('G3 transcript merge and validation', () => {
  function handoffDiagnostic(build: () => unknown) {
    try {
      build()
    } catch (error) {
      if (error instanceof TranscriptValidationError && error.repairDiagnostic) return error.repairDiagnostic
      throw error
    }
    throw new Error('expected strict handoff failure')
  }

  it('restores absolute offsets and removes deterministic overlap words', () => {
    const words = mergeChunkResults([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', words: [
        { text: 'Hello', startMs: 1_000, endMs: 1_400 }, { text: 'world.', startMs: 1_500, endMs: 2_000 },
        { text: 'Overlap', startMs: 10_000, endMs: 10_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', words: [
        { text: 'Overlap', startMs: 0, endMs: 500 }, { text: 'continues.', startMs: 600, endMs: 1_400 },
      ] } },
    ], 20_000)
    expect(words.map((word) => word.text)).toEqual(['Hello', 'world.', 'Overlap', 'continues.'])
    expect(words.at(-1)?.startMs).toBe(10_600)
    expect(segmentTranscript(words).map((cue) => cue.text)).toEqual(['Hello world.', 'Overlap continues.'])
  })

  it('rejects a missing chunk and does not create partial output', () => {
    expect(() => mergeChunkResults([
      { chunkIndex: 1, startMs: 0, endMs: 1_000, result: { language: 'en', words: [{ text: 'bad', startMs: 0, endMs: 100 }] } },
    ], 1_000)).toThrowError(TranscriptValidationError)
  })

  it('drops non-identical words wholly inside the overlap instead of regressing time', () => {
    const words = mergeChunkResults([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', words: [
        { text: 'Boundary', startMs: 9_000, endMs: 10_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', words: [
        { text: 'Different', startMs: 0, endMs: 400 }, { text: 'continues.', startMs: 600, endMs: 1_400 },
        { text: 'Ending.', startMs: 8_500, endMs: 9_500 },
      ] } },
    ], 20_000)
    expect(words.map((word) => word.text)).toEqual(['Boundary', 'continues.', 'Ending.'])
  })

  it('rejects a nominally successful result with a large uncovered interval', () => {
    expect(() => mergeChunkResults([
      { chunkIndex: 0, startMs: 0, endMs: 300_000, result: { language: 'en', words: [{ text: 'Only.', startMs: 100, endMs: 500 }] } },
    ], 300_000)).toThrow('large uncovered edge')
  })

  it.each([
    { words: [{ text: '', startMs: 0, endMs: 10 }] },
    { words: [{ text: 'late', startMs: 900, endMs: 1_100 }] },
    { words: [{ text: 'backward', startMs: 100, endMs: 100 }] },
  ])('rejects invalid word timing %#', ({ words: invalidWords }) => {
    expect(() => mergeChunkResults([
      { chunkIndex: 0, startMs: 0, endMs: 1_000, result: { language: 'en', words: invalidWords } },
    ], 1_000)).toThrowError(TranscriptValidationError)
  })

  it('publishes native MOSS segments as cues without fabricated word timings', () => {
    const transcript = buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'Welcome everyone.', startMs: 500, endMs: 2_000, speaker: 'S01' },
        { text: 'Overlap sentence.', startMs: 10_000, endMs: 11_500, speaker: 'S02' },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'Overlap sentence.', startMs: 0, endMs: 1_500, speaker: 'S02' },
        { text: 'Continue learning.', startMs: 2_000, endMs: 4_000, speaker: 'S01' },
      ] } },
    ], 20_000)
    expect(transcript.timingGranularity).toBe('segment')
    expect(transcript.wordCount).toBe(0)
    expect(transcript.cues.map((cue) => cue.text)).toEqual([
      'Welcome everyone.', 'Overlap sentence.', 'Continue learning.',
    ])
    expect(transcript.cues.every((cue) => cue.words.length === 0)).toBe(true)
    expect(transcript.cues.at(-1)).toMatchObject({ startMs: 12_000, endMs: 14_000 })
  })

  it('keeps segment timestamps strict while accepting a Provider-normalized terminal boundary', () => {
    expect(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 306_680, result: { language: 'en', segments: [
        { text: 'Terminal.', startMs: 0, endMs: 306_720, speaker: 'S01' },
      ] } },
    ], 306_680)).toThrowError(TranscriptValidationError)

    const transcript = buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 306_680, result: { language: 'en', segments: [
        { text: 'Terminal.', startMs: 0, endMs: 306_680, speaker: 'S01' },
      ] } },
    ], 306_680)
    expect(transcript.cues).toEqual([
      { order: 0, startMs: 0, endMs: 306_680, text: 'Terminal.', words: [] },
    ])
  })

  it('reconciles differently segmented overlap without dropping the new suffix or duplicating a cue', () => {
    const transcript = buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'We need to learn this today.', startMs: 9_000, endMs: 11_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'learn this today and practice.', startMs: 0, endMs: 2_000 },
        { text: 'The next idea.', startMs: 2_500, endMs: 4_000 },
      ] } },
    ], 20_000)
    expect(transcript.cues.map((cue) => cue.text)).toEqual([
      'We need to learn this today and practice.', 'The next idea.',
    ])
    expect(transcript.cues[0]).toMatchObject({ startMs: 9_000, endMs: 12_000, words: [] })
  })

  it('fails closed when overlapped segment text cannot be reconciled without guessing', () => {
    const build = () => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'We need to learn this today.', startMs: 9_000, endMs: 11_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'A completely different boundary.', startMs: 0, endMs: 2_000 },
      ] } },
    ], 20_000)
    expect(build).toThrow('ambiguous segment text')
    expect(handoffDiagnostic(build)).toMatchObject({
      kind: 'ambiguous_segment_handoff', previousChunkIndex: 0, nextChunkIndex: 1,
      overlapStartMs: 10_000, overlapEndMs: 12_000, overlapDurationMs: 2_000,
      previousBoundarySegmentCount: 1, nextBoundarySegmentCount: 1,
      previousBoundaryTokenCount: 6, nextBoundaryTokenCount: 4,
      textOnlyCandidateCount: 0, timeCompatibleCandidateCount: 0, speakerCompatibleCandidateCount: 0,
      maximumCandidateTokenCount: 0, failureClass: 'no_textual_suffix_prefix',
    })
  })

  it('does not deduplicate repeated text when the real segment times identify separate occurrences', () => {
    expect(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'Thank you.', startMs: 10_000, endMs: 10_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'Thank you.', startMs: 1_000, endMs: 1_500 },
        { text: 'Next topic.', startMs: 2_500, endMs: 3_500 },
      ] } },
    ], 20_000)).toThrow('ambiguous segment text')
  })

  it('fails closed when repeated tokens allow more than one overlap alignment', () => {
    const diagnostic = handoffDiagnostic(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 11_500, result: { language: 'en', segments: [
        { text: 'go go go', startMs: 10_000, endMs: 11_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_500, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'go go go', startMs: 0, endMs: 1_500 },
        { text: 'next', startMs: 2_000, endMs: 2_500 },
      ] } },
    ], 20_000))
    expect(diagnostic).toMatchObject({
      textOnlyCandidateCount: 3, timeCompatibleCandidateCount: 3, speakerCompatibleCandidateCount: 3,
      maximumCandidateTokenCount: 3, failureClass: 'multiple_valid_alignments',
    })
  })

  it('fails closed when overlapping identical text has conflicting speaker evidence', () => {
    const diagnostic = handoffDiagnostic(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'Yes.', startMs: 10_000, endMs: 11_000, speaker: 'S01' },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'Yes.', startMs: 500, endMs: 1_500, speaker: 'S02' },
      ] } },
    ], 20_000))
    expect(diagnostic).toMatchObject({
      textOnlyCandidateCount: 1, timeCompatibleCandidateCount: 1, speakerCompatibleCandidateCount: 0,
      maximumCandidateTokenCount: 0, failureClass: 'text_time_match_with_speaker_conflict',
    })
  })

  it('fails closed when identical boundary text lacks temporal overlap', () => {
    const diagnostic = handoffDiagnostic(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'Shared.', startMs: 9_000, endMs: 10_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'Shared.', startMs: 1_800, endMs: 3_000 },
      ] } },
    ], 20_000))
    expect(diagnostic).toMatchObject({
      textOnlyCandidateCount: 1, timeCompatibleCandidateCount: 0, speakerCompatibleCandidateCount: 0,
      maximumCandidateTokenCount: 0, failureClass: 'text_match_without_time_overlap',
    })
  })

  it('fails closed when only one non-exhaustive boundary token aligns', () => {
    const diagnostic = handoffDiagnostic(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 12_000, result: { language: 'en', segments: [
        { text: 'Prefix shared', startMs: 9_000, endMs: 11_500 },
      ] } },
      { chunkIndex: 1, startMs: 10_000, endMs: 20_000, result: { language: 'en', segments: [
        { text: 'shared suffix', startMs: 0, endMs: 2_000 },
      ] } },
    ], 20_000))
    expect(diagnostic).toMatchObject({
      textOnlyCandidateCount: 1, timeCompatibleCandidateCount: 1, speakerCompatibleCandidateCount: 1,
      maximumCandidateTokenCount: 1, failureClass: 'weak_single_token_alignment',
    })
  })

  it('rejects mixed word-only and segment-only chunk representations', () => {
    expect(() => buildTranscript([
      { chunkIndex: 0, startMs: 0, endMs: 1_000, result: { language: 'en', words: [
        { text: 'Hello.', startMs: 0, endMs: 800 },
      ] } },
      { chunkIndex: 1, startMs: 800, endMs: 2_000, result: { language: 'en', segments: [
        { text: 'World.', startMs: 200, endMs: 1_000 },
      ] } },
    ], 2_000)).toThrow('one complete timing representation')
  })
})
