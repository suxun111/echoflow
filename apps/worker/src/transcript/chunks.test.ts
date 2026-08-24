import { describe, expect, it } from 'vitest'
import { parseSilenceCenters, parseSilenceWindows, planAudioChunks, planBoundaryRepair } from './chunks'

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

  it('covers the full 60-minute V1 boundary with stable contiguous indexes', () => {
    const plan = planAudioChunks(3_600_000, 600_000, 2_000, [])
    expect(plan).toHaveLength(6)
    expect(plan[0]).toMatchObject({ chunkIndex: 0, startMs: 0, endMs: 602_000 })
    expect(plan.at(-1)).toMatchObject({ chunkIndex: 5, startMs: 2_998_000, endMs: 3_600_000 })
    expect(plan.every((chunk, index) => chunk.chunkIndex === index
      && (index === 0 || chunk.startMs <= plan[index - 1].endMs))).toBe(true)
  })

  it('parses ffmpeg silence pairs into center timestamps', () => {
    expect(parseSilenceCenters('[silencedetect] silence_start: 9.5\n[silencedetect] silence_end: 10.5 | silence_duration: 1')).toEqual([10_000])
    expect(parseSilenceWindows('[silencedetect] silence_start: 9.5\n[silencedetect] silence_end: 10.5 | silence_duration: 1')).toEqual([
      { startMs: 9_500, endMs: 10_500, centerMs: 10_000, durationMs: 1_000 },
    ])
  })

  it('creates a bounded two-chunk repair at the strongest different nearby silence', () => {
    const repair = planBoundaryRepair([
      { chunkIndex: 0, startMs: 0, endMs: 62_000 },
      { chunkIndex: 1, startMs: 58_000, endMs: 80_000 },
    ], 0, 80_000, 2_000, [
      { startMs: 59_500, endMs: 60_500, centerMs: 60_000, durationMs: 1_000 },
      { startMs: 48_000, endMs: 50_000, centerMs: 49_000, durationMs: 2_000 },
    ])
    expect(repair).toEqual({
      previousChunkIndex: 0,
      nextChunkIndex: 1,
      originalBoundaryMs: 60_000,
      replacementBoundaryMs: 49_000,
      replacementChunks: [
        { chunkIndex: 0, startMs: 0, endMs: 51_000 },
        { chunkIndex: 1, startMs: 47_000, endMs: 80_000 },
      ],
    })
  })

  it('refuses a repair when no distinct valid silence exists', () => {
    expect(planBoundaryRepair([
      { chunkIndex: 0, startMs: 0, endMs: 62_000 },
      { chunkIndex: 1, startMs: 58_000, endMs: 80_000 },
    ], 0, 80_000, 2_000, [
      { startMs: 59_500, endMs: 60_500, centerMs: 60_000, durationMs: 1_000 },
    ])).toBeNull()
  })
})
