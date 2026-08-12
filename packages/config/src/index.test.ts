import { describe, expect, it } from 'vitest'
import { loadServerEnv } from './index'

const valid = {
  NODE_ENV: 'production',
  API_PORT: '3001',
  DATABASE_URL: 'postgresql://user:password@db.example:5432/echoflow',
  ACCESS_TOKEN_SECRET: 'a-secure-access-secret-with-32-characters',
  REFRESH_TOKEN_PEPPER: 'a-secure-refresh-pepper-with-32-characters',
  OTP_HMAC_SECRET: 'a-secure-otp-secret-with-32-characters',
  CORS_ALLOWED_ORIGINS: 'https://echoflow.example',
  AUTH_EXPOSE_TEST_OTP: 'false',
  REFRESH_COOKIE_SECURE: 'true',
}

describe('server environment safety', () => {
  it('accepts explicit production secrets and an allowlist', () => {
    expect(loadServerEnv(valid).CORS_ALLOWED_ORIGINS).toEqual(['https://echoflow.example'])
  })

  it.each([
    ['ACCESS_TOKEN_SECRET', undefined],
    ['REFRESH_TOKEN_PEPPER', undefined],
    ['OTP_HMAC_SECRET', undefined],
    ['CORS_ALLOWED_ORIGINS', '*'],
    ['AUTH_EXPOSE_TEST_OTP', 'true'],
    ['REFRESH_COOKIE_SECURE', 'false'],
    ['DATABASE_URL', 'postgresql://user:password@db.example:5432/online_learning'],
  ])('rejects unsafe production setting %s', (key, value) => {
    const candidate: Record<string, string | undefined> = { ...valid, [key]: value }
    expect(() => loadServerEnv(candidate)).toThrow()
  })

  it('rejects an allowlist containing no valid origin', () => {
    expect(() => loadServerEnv({ ...valid, CORS_ALLOWED_ORIGINS: ' ,  ' })).toThrow()
  })
})
