import type { TranscriptWord } from '@online-learning/contracts'
import type { MossResult, MossSegment } from '../moss/adapter'

export type ChunkResult = {
  chunkIndex: number
  startMs: number
  endMs: number
  result: MossResult
}

export type TranscriptCueDraft = {
  order: number
  startMs: number
  endMs: number
  text: string
  words: TranscriptWord[]
}

export class TranscriptValidationError extends Error {
  constructor(readonly code: 'transcript_incomplete' | 'transcript_timing_invalid', message: string) {
    super(message)
    this.name = 'TranscriptValidationError'
  }
}

function token(text: string) {
  return text.toLocaleLowerCase('en-US').replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
}

function validateChunkSequence(chunks: ChunkResult[], durationMs: number) {
  if (!Number.isInteger(durationMs) || durationMs <= 0 || chunks.length === 0) {
    throw new TranscriptValidationError('transcript_incomplete', 'transcript has no complete chunks')
  }
  const sorted = chunks.slice().sort((left, right) => left.chunkIndex - right.chunkIndex)
  sorted.forEach((chunk, index) => {
    if (chunk.chunkIndex !== index || chunk.startMs < 0 || chunk.endMs <= chunk.startMs || chunk.endMs > durationMs) {
      throw new TranscriptValidationError('transcript_incomplete', 'chunk sequence is incomplete or out of range')
    }
    if (index > 0 && chunk.startMs > sorted[index - 1].endMs) {
      throw new TranscriptValidationError('transcript_incomplete', 'chunk sequence contains an uncovered gap')
    }
  })
  return sorted
}

function normalizeChunkWords(chunk: ChunkResult): TranscriptWord[] {
  const duration = chunk.endMs - chunk.startMs
  const words = chunk.result.words ?? []
  if (chunk.result.language !== 'en' || words.length === 0) {
    throw new TranscriptValidationError('transcript_incomplete', `chunk ${chunk.chunkIndex} has no English words`)
  }
  return words.map((word) => {
    const text = word.text.trim()
    if (!text || !Number.isInteger(word.startMs) || !Number.isInteger(word.endMs)
      || word.startMs < 0 || word.endMs <= word.startMs || word.endMs > duration) {
      throw new TranscriptValidationError('transcript_timing_invalid', `chunk ${chunk.chunkIndex} has invalid word timing`)
    }
    return { text, startMs: chunk.startMs + word.startMs, endMs: chunk.startMs + word.endMs }
  })
}

function overlapLength(previous: TranscriptWord[], next: TranscriptWord[]) {
  const limit = Math.min(64, previous.length, next.length)
  for (let size = limit; size > 0; size -= 1) {
    const suffix = previous.slice(-size)
    const prefix = next.slice(0, size)
    const sameTokens = suffix.every((word, index) => token(word.text) !== '' && token(word.text) === token(prefix[index].text))
    if (!sameTokens) continue
    const closeInTime = suffix.every((word, index) => Math.abs(word.startMs - prefix[index].startMs) <= 3_000)
    if (closeInTime) return size
  }
  return 0
}

export function mergeChunkResults(chunks: ChunkResult[], durationMs: number): TranscriptWord[] {
  const sorted = validateChunkSequence(chunks, durationMs)

  const merged: TranscriptWord[] = []
  for (const chunk of sorted) {
    const words = normalizeChunkWords(chunk)
    const appended = words.slice(overlapLength(merged, words))
    while (merged.length && appended.length && appended[0].endMs <= merged[merged.length - 1].endMs) appended.shift()
    merged.push(...appended)
  }
  if (merged.length === 0) throw new TranscriptValidationError('transcript_incomplete', 'transcript contains no words')
  for (let index = 0; index < merged.length; index += 1) {
    const word = merged[index]
    if (word.startMs < 0 || word.endMs > durationMs || word.endMs <= word.startMs
      || (index > 0 && (word.startMs < merged[index - 1].startMs || word.endMs < merged[index - 1].endMs))) {
      throw new TranscriptValidationError('transcript_timing_invalid', 'merged word timings are not monotonic')
    }
  }
  const maximumUncoveredMs = 120_000
  if (merged[0].startMs > maximumUncoveredMs || durationMs - merged[merged.length - 1].endMs > maximumUncoveredMs) {
    throw new TranscriptValidationError('transcript_incomplete', 'transcript has a large uncovered edge')
  }
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index].startMs - merged[index - 1].endMs > maximumUncoveredMs) {
      throw new TranscriptValidationError('transcript_incomplete', 'transcript has a large uncovered interval')
    }
  }
  return merged
}

type AbsoluteSegment = MossSegment & { startMs: number; endMs: number }

function normalizeChunkSegments(chunk: ChunkResult): AbsoluteSegment[] {
  const duration = chunk.endMs - chunk.startMs
  const segments = chunk.result.segments ?? []
  if (chunk.result.language !== 'en' || segments.length === 0) {
    throw new TranscriptValidationError('transcript_incomplete', `chunk ${chunk.chunkIndex} has no English segments`)
  }
  return segments.map((segment) => {
    const text = segment.text.trim()
    if (!text || !Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs)
      || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > duration) {
      throw new TranscriptValidationError('transcript_timing_invalid', `chunk ${chunk.chunkIndex} has invalid segment timing`)
    }
    return {
      text, startMs: chunk.startMs + segment.startMs, endMs: chunk.startMs + segment.endMs,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
    }
  })
}

type TextToken = { raw: string; normalized: string }
type TimedTextToken = TextToken & { startMs: number; endMs: number; speaker?: string }

function textTokens(text: string): TextToken[] {
  return text.split(/\s+/).map((raw) => ({ raw, normalized: token(raw) })).filter((part) => part.normalized !== '')
}

function timedTextTokens(segments: AbsoluteSegment[]): TimedTextToken[] {
  return segments.flatMap((segment) => textTokens(segment.text).map((part) => ({
    ...part, startMs: segment.startMs, endMs: segment.endMs,
    ...(segment.speaker ? { speaker: segment.speaker } : {}),
  })))
}

function mergeBoundaryText(previousSegments: AbsoluteSegment[], nextSegments: AbsoluteSegment[]) {
  const previousText = previousSegments.map((segment) => segment.text).join(' ')
  const nextText = nextSegments.map((segment) => segment.text).join(' ')
  const previous = timedTextTokens(previousSegments)
  const next = timedTextTokens(nextSegments)
  const limit = Math.min(previous.length, next.length)
  const candidates: number[] = []
  for (let size = limit; size > 0; size -= 1) {
    if (previous.slice(-size).every((part, index) => (
      part.normalized === next[index].normalized
      && Math.max(part.startMs, next[index].startMs) < Math.min(part.endMs, next[index].endMs)
      && (!part.speaker || !next[index].speaker || part.speaker === next[index].speaker)
    ))) {
      candidates.push(size)
    }
  }
  const overlap = candidates.length === 1 ? candidates[0] : 0
  const overlapIsStrong = overlap >= 2 || overlap === previous.length || overlap === next.length
  if (!overlapIsStrong) {
    throw new TranscriptValidationError(
      'transcript_incomplete',
      'overlapped chunks have ambiguous segment text at the handoff boundary',
    )
  }
  const tail = next.slice(overlap).map((part) => part.raw).join(' ')
  if (!tail) return previousText.trim()
  const continuing = previousText.trim().replace(/[.!?]+(["')\]]*)$/, '$1')
  return `${continuing} ${tail}`.trim()
}

function reconcileSegmentBoundary(
  previous: AbsoluteSegment[],
  next: AbsoluteSegment[],
  overlapStartMs: number,
  overlapEndMs: number,
) {
  const previousBoundaryStart = previous.findIndex((segment) => segment.endMs > overlapStartMs)
  let nextBoundaryEnd = 0
  while (nextBoundaryEnd < next.length && next[nextBoundaryEnd].startMs < overlapEndMs) nextBoundaryEnd += 1
  if (previousBoundaryStart < 0 || nextBoundaryEnd === 0) return { previous, next }

  const previousBoundary = previous.slice(previousBoundaryStart)
  const nextBoundary = next.slice(0, nextBoundaryEnd)
  const text = mergeBoundaryText(previousBoundary, nextBoundary)
  const speakers = new Set([...previousBoundary, ...nextBoundary].map((segment) => segment.speaker).filter(Boolean))
  const boundary: AbsoluteSegment = {
    text,
    startMs: Math.min(...previousBoundary.map((segment) => segment.startMs), ...nextBoundary.map((segment) => segment.startMs)),
    endMs: Math.max(...previousBoundary.map((segment) => segment.endMs), ...nextBoundary.map((segment) => segment.endMs)),
    ...(speakers.size === 1 ? { speaker: [...speakers][0] } : {}),
  }
  return {
    previous: [...previous.slice(0, previousBoundaryStart), boundary],
    next: next.slice(nextBoundaryEnd),
  }
}

function validateCoverage<T extends { startMs: number; endMs: number }>(items: T[], durationMs: number, label: string) {
  if (items.length === 0) throw new TranscriptValidationError('transcript_incomplete', `transcript contains no ${label}`)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.startMs < 0 || item.endMs > durationMs || item.endMs <= item.startMs
      || (index > 0 && (item.startMs < items[index - 1].startMs || item.endMs < items[index - 1].endMs))) {
      throw new TranscriptValidationError('transcript_timing_invalid', `merged ${label} timings are not monotonic`)
    }
  }
  const maximumUncoveredMs = 120_000
  if (items[0].startMs > maximumUncoveredMs || durationMs - items[items.length - 1].endMs > maximumUncoveredMs) {
    throw new TranscriptValidationError('transcript_incomplete', 'transcript has a large uncovered edge')
  }
  for (let index = 1; index < items.length; index += 1) {
    if (items[index].startMs - items[index - 1].endMs > maximumUncoveredMs) {
      throw new TranscriptValidationError('transcript_incomplete', 'transcript has a large uncovered interval')
    }
  }
}

function mergeSegmentResults(chunks: ChunkResult[], durationMs: number): AbsoluteSegment[] {
  const sorted = validateChunkSequence(chunks, durationMs)
  let merged = normalizeChunkSegments(sorted[0])
  for (let index = 1; index < sorted.length; index += 1) {
    const previousChunk = sorted[index - 1]
    const chunk = sorted[index]
    const reconciled = reconcileSegmentBoundary(
      merged,
      normalizeChunkSegments(chunk),
      chunk.startMs,
      previousChunk.endMs,
    )
    merged = [...reconciled.previous, ...reconciled.next]
  }
  validateCoverage(merged, durationMs, 'segment')
  return merged
}

function cueText(words: TranscriptWord[]) {
  return words.reduce((text, word) => {
    if (!text) return word.text
    return /^[,.;:!?%)]/.test(word.text) ? `${text}${word.text}` : `${text} ${word.text}`
  }, '')
}

export function segmentTranscript(words: TranscriptWord[]): TranscriptCueDraft[] {
  const cues: TranscriptCueDraft[] = []
  let current: TranscriptWord[] = []
  const flush = () => {
    if (!current.length) return
    cues.push({
      order: cues.length,
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text: cueText(current),
      words: current,
    })
    current = []
  }
  for (const word of words) {
    const previous = current[current.length - 1]
    if (previous && word.startMs - previous.endMs >= 900) flush()
    current.push(word)
    if (/[.!?][\"')\]]?$/.test(word.text) || current.length >= 14) flush()
  }
  flush()
  return cues
}

export function buildTranscript(chunks: ChunkResult[], durationMs: number) {
  const allHaveWords = chunks.length > 0 && chunks.every((chunk) => (chunk.result.words?.length ?? 0) > 0)
  if (allHaveWords) {
    const words = mergeChunkResults(chunks, durationMs)
    return { cues: segmentTranscript(words), wordCount: words.length, timingGranularity: 'word' as const }
  }
  const allHaveSegments = chunks.length > 0 && chunks.every((chunk) => (chunk.result.segments?.length ?? 0) > 0)
  if (!allHaveSegments) {
    throw new TranscriptValidationError('transcript_incomplete', 'all chunks must use one complete timing representation')
  }
  const segments = mergeSegmentResults(chunks, durationMs)
  return {
    cues: segments.map((segment, order) => ({
      order, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, words: [],
    })),
    wordCount: 0,
    timingGranularity: 'segment' as const,
  }
}
