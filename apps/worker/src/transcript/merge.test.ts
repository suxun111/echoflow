import { describe, expect, it } from 'vitest'
import { mergeChunkResults, segmentTranscript, TranscriptValidationError } from './merge'

describe('G3 transcript merge and validation', () => {
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
})
