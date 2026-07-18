import { describe, expect, it } from 'vitest'
import { formatTime, parseSubtitles, parseTimestamp } from './subtitles'

describe('subtitle utilities', () => {
  it('parses and sorts SRT cues', () => {
    const cues = parseSubtitles(`2\n00:00:03,000 --> 00:00:04,200\nSecond line\n\n1\n00:00:00,000 --> 00:00:02,500\n<i>First</i> line`)
    expect(cues.map((cue) => cue.text)).toEqual(['First line', 'Second line'])
    expect(cues[0].start).toBe(0)
  })
  it('parses a VTT cue with metadata', () => {
    const cues = parseSubtitles(`WEBVTT\n\nintro\n00:01.500 --> 00:03.250 align:start\nHello there`)
    expect(cues[0]).toMatchObject({ start: 1.5, end: 3.25, text: 'Hello there' })
  })
  it('rejects empty and invalid timing content', () => {
    expect(() => parseSubtitles('')).toThrow('请粘贴')
    expect(() => parseSubtitles('1\n00:00:03,000 --> 00:00:02,000\nNope')).toThrow('结束时间')
  })
  it('formats and parses timestamps', () => {
    expect(parseTimestamp('01:02:03.045')).toBe(3723.045)
    expect(formatTime(65.8)).toBe('1:05')
  })
})
