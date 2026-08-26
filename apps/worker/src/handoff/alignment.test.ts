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

  it('returns a scripted accepted result deterministically', async () => {
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

  it('never exposes content fields in adapter I/O (shape guard)', async () => {
    const adapter = new InMemoryAlignmentAdapter()
    const { externalJobId } = await adapter.submit(submitInput())
    adapter.scriptOutcome(externalJobId, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 900 },
    })
    const result = await adapter.read(externalJobId)
    const keys = Object.keys(result)
    expect(keys).not.toContain('text')
    expect(keys).not.toContain('audio')
    expect(keys).not.toContain('rawPayload')
    expect(keys).not.toContain('objectKey')
  })
})
