import { loadServerEnv } from '@online-learning/config'

export const G2TestDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_integration_test'

export function createTestEnv() {
  return loadServerEnv({
    NODE_ENV: 'test',
    API_PORT: '3001',
    DATABASE_URL: G2TestDatabaseUrl,
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
    MINIO_ENDPOINT: 'localhost',
    MINIO_PORT: '9000',
    MINIO_USE_SSL: 'false',
    MINIO_ACCESS_KEY: 'online_learning',
    MINIO_SECRET_KEY: 'online_learning_secret',
    MINIO_BUCKET: 'echoflow-g2-api-test',
    UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024),
    UPLOAD_SESSION_TTL_SECONDS: String(7 * 24 * 3600),
    STORAGE_SIGNED_URL_TTL_SECONDS: '900',
    MOSS_ENABLED: 'true',
    MOSS_BASE_URL: 'https://moss.test',
    MOSS_API_TOKEN: 'test-moss-api-token-long-enough',
    MOSS_CALLBACK_SECRET: 'test-moss-callback-secret-at-least-32-characters',
    MOSS_CALLBACK_PUBLIC_URL: 'https://api.test/api/v1/integrations/moss/callback',
  })
}
