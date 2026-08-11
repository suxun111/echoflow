import { describe, expect, it } from 'vitest'
import { normalizeMossSegments, offsetCues } from './pipeline'

describe('MOSS subtitle normalization', () => {
  it('converts MOSS seconds, speakers, and text into ordered millisecond cues', () => {
    expect(normalizeMossSegments({ segments: [
      { start: 0.25, end: 1.75, speaker: 'S01', text: 'Hello there.' },
      { start: 2, end: 3.5, speaker: 'S02', text: 'Welcome back.' },
    ] })).toEqual([
      { order: 0, startMs: 250, endMs: 1750, speaker: 'S01', english: 'Hello there.' },
      { order: 1, startMs: 2000, endMs: 3500, speaker: 'S02', english: 'Welcome back.' },
    ])
  })

  it('drops malformed or empty source segments instead of writing invalid subtitle rows', () => {
    expect(normalizeMossSegments([{ start: 2, end: 1, text: 'bad' }, { start: 1, end: 2, text: '  ' }])).toEqual([])
  })

  it('restores chunk offsets before the combined cues are stored', () => {
    expect(offsetCues([{ order: 0, startMs: 250, endMs: 1750, speaker: 'S01', english: 'Chunked cue.' }], 45000)).toEqual([
      { order: 0, startMs: 45250, endMs: 46750, speaker: 'S01', english: 'Chunked cue.' },
    ])
  })
})
