import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  AlignmentAdapterError,
  InMemoryAlignmentAdapter,
  type AlignmentSubmitInput,
} from './index'

const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')

function submitInput(overrides: Partial<AlignmentSubmitInput> = {}): AlignmentSubmitInput {
  return {
    idempotencyKey: 'g3v2:fake-idempotency',
    correlationHandle: 'fake-correlation-handle-0001',
    pipelineVersion: 'g3-transcript-v2',
    windowStartMs: 1000,
    windowEndMs: 2000,
    methodDigest: hex64('method'),
    modelDigest: hex64('model'),
    configDigest: hex64('config'),
    ...overrides,
  }
}

describe('InMemoryAlignmentAdapter', () => {
  it('submits a deterministic job and returns an opaque external identity', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const submission = await adapter.submit(submitInput())
    expect(submission.externalJobId).toMatch(/^fake-align-\d+$/)
    expect(submission.correlationHandle).toBe('fake-correlation-handle-0001')
    expect(adapter.submittedCount()).toBe(1)
  })

  it('rejects a duplicate idempotency identity (must be a new job, never a retry)', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    await adapter.submit(submitInput())
    await expect(adapter.submit(submitInput())).rejects.toThrow(AlignmentAdapterError)
  })

  it('allows a response-loss reservation to be adopted by its idempotency identity', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    adapter.scriptResponseLossOnce()
    await expect(adapter.submit(submitInput())).rejects.toMatchObject({ code: 'response_lost' })

    const adopted = await adapter.findByIdempotencyKey('g3v2:fake-idempotency')
    expect(adopted).toEqual({
      correlationHandle: 'fake-correlation-handle-0001',
      externalJobId: 'fake-align-1',
    })
    expect(adapter.submittedCount()).toBe(1)
  })

  it('rejects a reused correlation handle', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    await adapter.submit(submitInput())
    await expect(
      adapter.submit(submitInput({ idempotencyKey: 'g3v2:other-idempotency' })),
    ).rejects.toThrow(AlignmentAdapterError)
  })

  it('rejects invalid submit input', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    await expect(
      adapter.submit(submitInput({ windowStartMs: 2000, windowEndMs: 1000 })),
    ).rejects.toThrow(AlignmentAdapterError)
  })

  it('reports PENDING before any scripted outcome', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    const status = await adapter.query(externalJobId)
    expect(status.state).toBe('PENDING')
    await expect(adapter.read(externalJobId)).rejects.toThrow(AlignmentAdapterError)
  })

  it('can script a retryable query error without changing the persisted job identity', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    adapter.scriptQueryErrorOnce(externalJobId, 'alignment_timeout')
    await expect(adapter.query(externalJobId)).rejects.toMatchObject({ code: 'alignment_timeout' })
    await expect(adapter.query(externalJobId)).resolves.toMatchObject({ externalJobId, state: 'PENDING' })
  })

  it('can script transient lookup and submit failures without creating a provider reservation', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    adapter.scriptFindErrorOnce('alignment_unavailable')
    await expect(adapter.findByIdempotencyKey('g3v2:fake-idempotency')).rejects.toMatchObject({ code: 'alignment_unavailable' })
    adapter.scriptSubmitErrorOnce('alignment_rate_limited')
    await expect(adapter.submit(submitInput())).rejects.toMatchObject({ code: 'alignment_rate_limited' })
    expect(adapter.submittedCount()).toBe(0)
  })

  it('returns a scripted provider-level accepted result deterministically (not final evidence)', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    adapter.scriptOutcome(externalJobId, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 900 },
    })
    expect((await adapter.query(externalJobId)).state).toBe('SUCCEEDED')
    const result = await adapter.read(externalJobId)
    expect(result).toEqual({
      externalJobId,
      decision: 'accepted',
      decisionCode: 'evidence_accepted',
      candidateCount: 1,
      anchorCount: 2,
      coverageMs: 900,
    })
  })

  it('returns a scripted insufficient result (fail-closed path)', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    adapter.scriptOutcome(externalJobId, {
      state: 'FAILED',
      result: { decision: 'insufficient', decisionCode: 'alignment_result_invalid', candidateCount: 0, anchorCount: 0, coverageMs: 0 },
    })
    const result = await adapter.read(externalJobId)
    expect(result.decision).toBe('insufficient')
    expect(result.decisionCode).toBe('alignment_result_invalid')
  })

  it('cancel transitions to insufficient/alignment_cancelled and is best-effort', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    await adapter.cancel(externalJobId)
    expect((await adapter.query(externalJobId)).state).toBe('CANCELLED')
    const result = await adapter.read(externalJobId)
    expect(result.decisionCode).toBe('alignment_cancelled')
    await expect(adapter.cancel('unknown-job')).rejects.toThrow(AlignmentAdapterError)
  })

  it('never exposes content or raw-object identity fields in adapter I/O (shape guard)', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    adapter.scriptOutcome(externalJobId, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 900 },
    })
    const result = await adapter.read(externalJobId)
    const keys = Object.keys(result)
    for (const forbidden of [
      'text',
      'audio',
      'rawPayload',
      'objectKey',
      'versionId',
      'checksum',
      'url',
      'proofDigest',
      'rawChecksum',
      'rawVersionId',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
