import type { Cue } from '../types'

const timingPattern = /^\s*(?<start>(?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s+-->\s+(?<end>(?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})/

export function parseTimestamp(value: string): number {
  const normalized = value.trim().replace(',', '.')
  const [time, milliseconds = '0'] = normalized.split('.')
  const segments = time.split(':').map(Number)
  if (segments.some(Number.isNaN) || segments.length < 2 || segments.length > 3) {
    throw new Error(`无法识别时间：${value}`)
  }
  const seconds = segments.length === 3
    ? segments[0] * 3600 + segments[1] * 60 + segments[2]
    : segments[0] * 60 + segments[1]
  const ms = Number(milliseconds.padEnd(3, '0').slice(0, 3))
  if (!Number.isFinite(seconds) || !Number.isFinite(ms)) throw new Error(`无法识别时间：${value}`)
  return seconds + ms / 1000
}

function cleanText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseSubtitles(source: string): Cue[] {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  if (!normalized) throw new Error('请粘贴字幕内容或上传字幕文件。')

  const blocks = normalized.split(/\n\s*\n/)
  const cues: Cue[] = []
  let cueNumber = 0

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    if (!lines.length || /^WEBVTT/i.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue
    const timingIndex = lines.findIndex((line) => timingPattern.test(line))
    if (timingIndex === -1) continue
    const match = lines[timingIndex].match(timingPattern)
    if (!match?.groups) continue
    const start = parseTimestamp(match.groups.start)
    const end = parseTimestamp(match.groups.end)
    const text = cleanText(lines.slice(timingIndex + 1))
    if (!text) continue
    if (end <= start) throw new Error(`第 ${cueNumber + 1} 条字幕的结束时间必须晚于开始时间。`)
    cues.push({ id: `cue-${cueNumber++}-${Math.round(start * 1000)}`, start, end, text })
  }
  if (!cues.length) throw new Error('没有找到有效字幕。请使用包含时间轴的 SRT 或 VTT 文件。')
  return cues.sort((a, b) => a.start - b.start)
}

export function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remaining}`
}
