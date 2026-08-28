/**
 * G3 transcript object lifecycle policy (pure, deterministic).
 *
 * Defines the versioned, fenced retention policy for every transcript object
 * kind. It is a pure decision function — no storage, no network, no media.
 *
 * F2 scope: HANDOFF_AUDIO ≈ 24h, ALIGNMENT_RAW ≤ 7d, orphan objects (a
 * tracked object whose processing run no longer exists) are immediately
 * eligible. This policy is deliberately NOT connected to the production
 * cleanup scanner until a separate storage-lifecycle contract is confirmed.
 */

export const TRANSCRIPT_OBJECT_KINDS = [
  'NORMALIZED_AUDIO',
  'AUDIO_CHUNK',
  'ASR_RAW',
  'HANDOFF_AUDIO',
  'ALIGNMENT_RAW',
] as const
export type TranscriptObjectKind = (typeof TRANSCRIPT_OBJECT_KINDS)[number]

export const HANDOFF_AUDIO_RETENTION_MS = 24 * 60 * 60_000
export const ALIGNMENT_RAW_RETENTION_MS = 7 * 24 * 60 * 60_000

const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const

/** Retention window for a transcript object kind (terminal-run TTL). */
export function transcriptObjectRetentionMs(kind: string): number {
  if (kind === 'ASR_RAW' || kind === 'ALIGNMENT_RAW') return ALIGNMENT_RAW_RETENTION_MS
  return HANDOFF_AUDIO_RETENTION_MS
}

export interface CleanupEligibilityInput {
  kind: string
  createdAt: Date
  deletedAt: Date | null
}

/**
 * Decide whether a transcript object may be cleaned now.
 *
 * - orphan (no run record)              -> immediately eligible
 * - run still active (non-terminal)     -> never eligible
 * - already tombstoned (deletedAt set)  -> immediately eligible
 * - terminal run, past retention window -> eligible
 */
export function isTranscriptObjectCleanupEligible(
  object: CleanupEligibilityInput,
  run: { status: string } | null,
  now: Date,
): boolean {
  if (run === null) return true
  if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return false
  if (object.deletedAt !== null) return true
  return object.createdAt.getTime() <= now.getTime() - transcriptObjectRetentionMs(object.kind)
}
