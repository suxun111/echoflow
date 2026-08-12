import { describe, expect, it } from 'vitest'
import { AccessSessionSchema, ApiErrorSchema, OtpRequestSchema } from './index'

describe('G1 contracts', () => {
  it('requires E.164 phones and rejects extra fields', () => {
    expect(OtpRequestSchema.parse({ phone: '+8613800000000' })).toEqual({ phone: '+8613800000000' })
    expect(() => OtpRequestSchema.parse({ phone: '13800000000' })).toThrow()
    expect(() => OtpRequestSchema.parse({ phone: '+8613800000000', ownerId: 'spoofed' })).toThrow()
  })

  it('never includes a refresh token in the access-session response', () => {
    expect(() => AccessSessionSchema.parse({
      accessToken: 'access', expiresInSeconds: 600, refreshToken: 'forbidden',
      user: { id: crypto.randomUUID(), phone: '+8613800000000', displayName: 'Learner', role: 'learner', status: 'active' },
    })).toThrow()
  })

  it('requires a stable error code and requestId', () => {
    expect(ApiErrorSchema.parse({ code: 'unauthenticated', message: 'unauthorized', requestId: 'request-123' }).code).toBe('unauthenticated')
    expect(() => ApiErrorSchema.parse({ code: 'made_up', message: 'bad', requestId: 'request-123' })).toThrow()
  })
})
