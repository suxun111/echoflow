import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createTestEnv } from '../../test/test-env'
import { MossCallbackController } from './moss-callback.module'

describe('MossCallbackController F2 v2 boundary', () => {
  it('ignores a signed stale v2 callback before receipt, chunk or Outbox writes', async () => {
    const env = createTestEnv()
    const body = {
      externalJobId: 'synthetic-provider-job-0001',
      idempotencyKey: 'synthetic-v2-callback-key-0001',
      status: 'succeeded' as const,
      occurredAt: new Date().toISOString(),
    }
    const rawBody = Buffer.from(JSON.stringify(body))
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const nonce = 'synthetic-v2-nonce-0001'
    const signature = `v1=${createHmac('sha256', env.MOSS_CALLBACK_SECRET!)
      .update(timestamp).update('.').update(nonce).update('.').update(rawBody).digest('hex')}`
    const transaction = {
      processingChunk: {
        findFirst: vi.fn(async () => ({
          id: 'synthetic-v2-chunk', status: 'PROCESSING',
          processingRun: {
            id: 'synthetic-v2-run', mediaAssetId: 'synthetic-v2-asset',
            status: 'PROCESSING', pipelineVersion: 'g3-transcript-v2',
          },
        })),
        updateMany: vi.fn(),
      },
      mossCallbackReceipt: { createMany: vi.fn(), findUnique: vi.fn() },
      outboxEvent: { create: vi.fn() },
    }
    const database = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) => callback(transaction)),
    }
    const controller = new MossCallbackController(database as never, env)

    await expect(controller.callback(
      { rawBody }, body,
      {
        'x-echoflow-event-id': 'synthetic-v2-event-0001',
        'x-echoflow-timestamp': timestamp,
        'x-echoflow-nonce': nonce,
        'x-echoflow-signature': signature,
      },
    )).resolves.toEqual({ accepted: true, duplicate: false, ignored: true })
    expect(transaction.mossCallbackReceipt.createMany).not.toHaveBeenCalled()
    expect(transaction.processingChunk.updateMany).not.toHaveBeenCalled()
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled()
  })
})
