import type { TranscriptWord } from '@online-learning/contracts'
import type { MossResult } from '../moss/adapter'

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

function normalizeChunk(chunk: ChunkResult): TranscriptWord[] {
  const duration = chunk.endMs - chunk.startMs
  if (chunk.result.language !== 'en' || chunk.result.words.length === 0) {
    throw new TranscriptValidationError('transcript_incomplete', `chunk ${chunk.chunkIndex} has no English words`)
  }
  return chunk.result.words.map((word) => {
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

  const merged: TranscriptWord[] = []
  for (const chunk of sorted) {
    const words = normalizeChunk(chunk)
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
