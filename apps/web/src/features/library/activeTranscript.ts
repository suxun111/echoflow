import type { ActiveTranscriptView, TranscriptCueView, TranscriptWord } from '@online-learning/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function assertTranscript(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_active_transcript')
}

function parseWord(value: unknown): TranscriptWord {
  assertTranscript(isRecord(value))
  assertTranscript(isNonEmptyString(value.text))
  assertTranscript(isNonNegativeInteger(value.startMs))
  assertTranscript(isPositiveInteger(value.endMs) && value.endMs > value.startMs)
  return { text: value.text, startMs: value.startMs, endMs: value.endMs }
}

function parseCue(value: unknown): TranscriptCueView {
  assertTranscript(isRecord(value))
  assertTranscript(isNonEmptyString(value.id))
  assertTranscript(isNonNegativeInteger(value.order))
  assertTranscript(isNonNegativeInteger(value.startMs))
  assertTranscript(isPositiveInteger(value.endMs) && value.endMs > value.startMs)
  assertTranscript(isNonEmptyString(value.text))
  assertTranscript(Array.isArray(value.words))
  return {
    id: value.id,
    order: value.order,
    startMs: value.startMs,
    endMs: value.endMs,
    text: value.text,
    words: value.words.map(parseWord),
  }
}

/**
 * A production-safe boundary parser for the owner-scoped ACTIVE transcript API.
 * It intentionally lives in Web because the shared contracts package currently
 * ships CommonJS runtime code that Vite cannot use as a named production import.
 */
export function parseActiveTranscriptView(value: unknown): ActiveTranscriptView {
  assertTranscript(isRecord(value))
  assertTranscript(isNonEmptyString(value.id))
  assertTranscript(isNonEmptyString(value.mediaAssetId))
  assertTranscript(isPositiveInteger(value.version))
  assertTranscript(value.language === 'en')
  assertTranscript(isPositiveInteger(value.durationMs))
  assertTranscript(isNonNegativeInteger(value.cueCount))
  assertTranscript(isNonEmptyString(value.pipelineVersion))
  assertTranscript(isNonEmptyString(value.modelVersion))
  assertTranscript(isNonEmptyString(value.publishedAt) && Number.isFinite(Date.parse(value.publishedAt)))
  assertTranscript(Array.isArray(value.cues))

  const cues = value.cues.map(parseCue)
  assertTranscript(value.cueCount === cues.length)
  return {
    id: value.id,
    mediaAssetId: value.mediaAssetId,
    version: value.version,
    language: 'en',
    durationMs: value.durationMs,
    cueCount: value.cueCount,
    pipelineVersion: value.pipelineVersion,
    modelVersion: value.modelVersion,
    publishedAt: value.publishedAt,
    cues,
  }
}
