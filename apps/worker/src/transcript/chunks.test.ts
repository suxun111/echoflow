import { describe, expect, it } from 'vitest'
import { parseSilenceCenters, planAudioChunks } from './chunks'

describe('G3 audio chunk planning', () => {
  it('selects a nearby silence and preserves a bounded overlap without gaps', () => {
    const plan = planAudioChunks(1_500_000, 600_000, 2_000, [590_000, 1_205_000])
    expect(plan).toEqual([
      { chunkIndex: 0, startMs: 0, endMs: 592_000 },
      { chunkIndex: 1, startMs: 588_000, endMs: 1_207_000 },
      { chunkIndex: 2, startMs: 1_203_000, endMs: 1_500_000 },
    ])
    expect(plan.every((chunk, index) => index === 0 || chunk.startMs <= plan[index - 1].endMs)).toBe(true)
  })

  it('falls back to the target boundary when no silence exists', () => {
    expect(planAudioChunks(1_300_000, 600_000, 1_000, [])).toHaveLength(2)
  })

  it('parses ffmpeg silence pairs into center timestamps', () => {
    expect(parseSilenceCenters('[silencedetect] silence_start: 9.5\n[silencedetect] silence_end: 10.5 | silence_duration: 1')).toEqual([10_000])
  })
})
