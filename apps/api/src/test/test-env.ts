import { loadServerEnv } from '@online-learning/config'

export const G1TestDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g1_integration_test'

export function createTestEnv() {
  return loadServerEnv({
    NODE_ENV: 'test',
    API_PORT: '3001',
    DATABASE_URL: G1TestDatabaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    ACCESS_TOKEN_SECRET: 'test-access-secret-with-at-least-32-characters',
    REFRESH_TOKEN_PEPPER: 'test-refresh-pepper-with-at-least-32-characters',
    OTP_HMAC_SECRET: 'test-otp-hmac-secret-with-at-least-32-characters',
    ACCESS_TOKEN_TTL_SECONDS: '600',
    REFRESH_SESSION_TTL_SECONDS: '2592000',
    OTP_TTL_SECONDS: '300',
    OTP_MAX_ATTEMPTS: '5',
    OTP_MIN_REQUEST_INTERVAL_SECONDS: '1',
    AUTH_EXPOSE_TEST_OTP: 'true',
    REFRESH_COOKIE_SECURE: 'false',
    CORS_ALLOWED_ORIGINS: 'http://localhost:4173,http://localhost:5173',
  })
}
