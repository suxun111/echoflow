import { describe, expect, it } from 'vitest'
import {
  ALIGNMENT_RAW_RETENTION_MS,
  HANDOFF_AUDIO_RETENTION_MS,
  isTranscriptObjectCleanupEligible,
  transcriptObjectRetentionMs,
  TRANSCRIPT_OBJECT_KINDS,
} from './object-lifecycle'

const now = new Date('2026-08-26T00:00:00.000Z')
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60_000)

describe('transcriptObjectRetentionMs', () => {
  it('assigns a 7-day retention to raw evidence kinds', () => {
    expect(transcriptObjectRetentionMs('ASR_RAW')).toBe(ALIGNMENT_RAW_RETENTION_MS)
    expect(transcriptObjectRetentionMs('ALIGNMENT_RAW')).toBe(ALIGNMENT_RAW_RETENTION_MS)
  })

  it('assigns a 24-hour retention to audio kinds', () => {
    expect(transcriptObjectRetentionMs('HANDOFF_AUDIO')).toBe(HANDOFF_AUDIO_RETENTION_MS)
    expect(transcriptObjectRetentionMs('AUDIO_CHUNK')).toBe(HANDOFF_AUDIO_RETENTION_MS)
    expect(transcriptObjectRetentionMs('NORMALIZED_AUDIO')).toBe(HANDOFF_AUDIO_RETENTION_MS)
  })

  it('covers every supported transcript object kind', () => {
    expect(TRANSCRIPT_OBJECT_KINDS).toContain('HANDOFF_AUDIO')
    expect(TRANSCRIPT_OBJECT_KINDS).toContain('ALIGNMENT_RAW')
  })
})

describe('isTranscriptObjectCleanupEligible', () => {
  const object = (overrides: Partial<{ kind: string; createdAt: Date; deletedAt: Date | null }> = {}) => ({
    kind: 'HANDOFF_AUDIO',
    createdAt: hoursAgo(25),
    deletedAt: null,
    ...overrides,
  })

  it('immediately cleans orphan objects whose run no longer exists', () => {
    expect(isTranscriptObjectCleanupEligible(object(), null, now)).toBe(true)
  })

  it('never cleans objects of an active (non-terminal) run', () => {
    expect(isTranscriptObjectCleanupEligible(object(), { status: 'PROCESSING' }, now)).toBe(false)
    expect(isTranscriptObjectCleanupEligible(object(), { status: 'QUEUED' }, now)).toBe(false)
  })

  it('immediately cleans a tombstoned object of a terminal run', () => {
    expect(isTranscriptObjectCleanupEligible(object({ deletedAt: now, createdAt: hoursAgo(1) }), { status: 'SUCCEEDED' }, now)).toBe(true)
  })

  it('cleans a terminal run object only after its retention window', () => {
    expect(isTranscriptObjectCleanupEligible(object({ kind: 'HANDOFF_AUDIO', createdAt: hoursAgo(25) }), { status: 'SUCCEEDED' }, now)).toBe(true)
    expect(isTranscriptObjectCleanupEligible(object({ kind: 'HANDOFF_AUDIO', createdAt: hoursAgo(1) }), { status: 'SUCCEEDED' }, now)).toBe(false)
  })

  it('keeps ALIGNMENT_RAW for up to seven days after a terminal run', () => {
    expect(isTranscriptObjectCleanupEligible(object({ kind: 'ALIGNMENT_RAW', createdAt: hoursAgo(6 * 24) }), { status: 'FAILED' }, now)).toBe(false)
    expect(isTranscriptObjectCleanupEligible(object({ kind: 'ALIGNMENT_RAW', createdAt: hoursAgo(8 * 24) }), { status: 'FAILED' }, now)).toBe(true)
  })
})
