/**
 * Proof-digest injection interface for the G3 v2 foundation.
 *
 * F1 authorizes an INJECTED Fake only: no production key source, no env
 * wiring, no rotation, no secret management. The digest is computed over a
 * canonical, NON-CONTENT identity envelope; it never carries subtitle text,
 * tokens, audio bytes, raw results, object keys/URLs or secrets.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { EvidenceType, HandoffDecision } from './types'

export interface PrivateEvidenceEnvelope {
  schemaVersion: string
  pipelineVersion: string
  processingRunId: string
  planRevision: number
  logicalHandoffIndex: number
  previousChunkId: string
  nextChunkId: string
  previousAsrObjectKey: string
  previousAsrVersionId: string | null
  previousAsrChecksum: string | null
  nextAsrObjectKey: string
  nextAsrVersionId: string | null
  nextAsrChecksum: string | null
  normalizedAudioVersionId: string | null
  normalizedAudioChecksum: string | null
  rawObjectKey: string | null
  rawVersionId: string | null
  rawChecksum: string | null
  methodProvider: string
  methodVersion: string
  modelRevision: string | null
  alignmentPolicyDigest: string | null
  windowStartMs: number
  windowEndMs: number
  decision: HandoffDecision
  decisionCode: string
  evidenceType: EvidenceType
}

export interface ProofDigestService {
  readonly keyVersion: string
  sign(envelope: PrivateEvidenceEnvelope): string
  verify(digest: string, envelope: PrivateEvidenceEnvelope): boolean
}

/** Canonical serialization: sorted keys, stable output, no undefined holes. */
export function canonicalEnvelopeJson(envelope: PrivateEvidenceEnvelope): string {
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(envelope).sort()) {
    const value = (envelope as unknown as Record<string, unknown>)[key]
    if (value !== undefined) ordered[key] = value
  }
  return JSON.stringify(ordered)
}

/**
 * Deterministic injected Fake used by F1 tests and future v2 worker tests.
 * The key is provided by the caller (test harness) only; this class never
 * reads env vars, files or any production key source.
 */
export class FakeProofDigestService implements ProofDigestService {
  readonly keyVersion: string
  private readonly key: Buffer

  constructor(key: Buffer, keyVersion = 'test-v1') {
    this.key = key
    this.keyVersion = keyVersion
  }

  sign(envelope: PrivateEvidenceEnvelope): string {
    return createHmac('sha256', this.key).update(canonicalEnvelopeJson(envelope)).digest('hex')
  }

  verify(digest: string, envelope: PrivateEvidenceEnvelope): boolean {
    const expected = Buffer.from(this.sign(envelope), 'hex')
    const actual = Buffer.from(digest, 'hex')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  }
}
