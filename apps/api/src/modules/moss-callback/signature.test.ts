import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyMossCallbackSignature } from './signature'

const secret = 'moss-callback-secret-at-least-32-characters'
const now = Date.parse('2026-08-13T06:00:00.000Z')
const timestamp = String(now / 1000)
const rawBody = Buffer.from('{"externalJobId":"moss-1"}')
const nonce = 'nonce-12345678'
const signature = `v1=${createHmac('sha256', secret).update(timestamp).update('.').update(nonce).update('.').update(rawBody).digest('hex')}`

describe('MOSS callback HMAC', () => {
  it('verifies the exact raw body and returns a stable payload hash', () => {
    expect(verifyMossCallbackSignature({
      eventId: 'event-12345678', timestamp, nonce, signature, rawBody,
    }, secret, 300, now)).toMatchObject({ eventId: 'event-12345678', nonce })
  })

  it.each([
    { signature: 'v1=' + '0'.repeat(64), rawBody },
    { signature, rawBody: Buffer.from('{"externalJobId":"moss-2"}') },
    { signature, rawBody: undefined },
  ])('rejects invalid signature material %#', (candidate) => {
    expect(() => verifyMossCallbackSignature({
      eventId: 'event-12345678', timestamp, nonce, ...candidate,
    }, secret, 300, now)).toThrow()
  })

  it('rejects stale timestamps before writing a receipt', () => {
    expect(() => verifyMossCallbackSignature({
      eventId: 'event-12345678', timestamp, nonce, signature, rawBody,
    }, secret, 300, now + 301_000)).toThrow('expired_timestamp')
  })
})
