import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type MossSignatureInput = {
  eventId: string | undefined
  timestamp: string | undefined
  nonce: string | undefined
  signature: string | undefined
  rawBody: Buffer | undefined
}

export class MossSignatureError extends Error {}

const identityPattern = /^[A-Za-z0-9._:-]{8,255}$/

export function verifyMossCallbackSignature(
  input: MossSignatureInput,
  secret: string,
  maxAgeSeconds: number,
  now = Date.now(),
) {
  if (!input.eventId || !identityPattern.test(input.eventId)) throw new MossSignatureError('invalid_event_id')
  if (!input.nonce || !identityPattern.test(input.nonce)) throw new MossSignatureError('invalid_nonce')
  if (!input.timestamp || !/^\d{10}$/.test(input.timestamp)) throw new MossSignatureError('invalid_timestamp')
  if (!input.rawBody) throw new MossSignatureError('raw_body_missing')
  const occurredAtMs = Number(input.timestamp) * 1000
  if (!Number.isSafeInteger(occurredAtMs) || Math.abs(now - occurredAtMs) > maxAgeSeconds * 1000) {
    throw new MossSignatureError('expired_timestamp')
  }
  const match = /^v1=([a-f0-9]{64})$/i.exec(input.signature ?? '')
  if (!match) throw new MossSignatureError('invalid_signature')
  const expected = createHmac('sha256', secret)
    .update(input.timestamp).update('.').update(input.nonce).update('.').update(input.rawBody).digest()
  const actual = Buffer.from(match[1], 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new MossSignatureError('invalid_signature')
  return {
    eventId: input.eventId,
    nonce: input.nonce,
    occurredAt: new Date(occurredAtMs),
    payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
  }
}
