import { z } from 'zod'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).default('postgresql://online_learning:online_learning@localhost:5432/online_learning'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32).default('development-only-secret-change-me-now'),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_ACCESS_KEY: z.string().default('online_learning'),
  MINIO_SECRET_KEY: z.string().default('online_learning_secret'),
  MINIO_BUCKET: z.string().default('online-learning'),
  DEV_USER_ID: z.string().min(1).default('local-learner'),
  DEV_USER_PHONE: z.string().min(1).default('13900000000'),
  DEV_USER_DISPLAY_NAME: z.string().min(1).default('EchoFlow Local'),
  MEDIA_TMP_DIR: z.string().min(1).default('tmp/media'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  MOSS_SERVICE_URL: z.string().url().default('http://127.0.0.1:8001'),
  MOSS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MOSS_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  MOSS_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  MOSS_TIMEOUT_MS: z.coerce.number().int().positive().default(660000),
  MOSS_POLL_MS: z.coerce.number().int().positive().default(2000),
  MOSS_MAX_NEW_TOKENS: z.coerce.number().int().positive().default(4096),
  MOSS_MAX_LENGTH: z.coerce.number().int().positive().default(16384),
  MOSS_CHUNK_SECONDS: z.coerce.number().int().min(10).max(120).default(45),
  MOSS_RECOVERY_CHUNK_SECONDS: z.coerce.number().int().min(5).max(30).default(15),
  VOLCENGINE_TRANSLATE: z.enum(['true', 'false']).default('false'),
  VOLCENGINE_ACCESS_KEY_ID: z.string().optional(),
  VOLCENGINE_SECRET_ACCESS_KEY: z.string().optional(),
  VOLCENGINE_TRANSLATE_ENDPOINT: z.string().url().default('https://open.volcengineapi.com'),
  VOLCENGINE_REGION: z.string().min(1).default('cn-beijing'),
  VOLCENGINE_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  VOLCENGINE_TRANSLATE_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(20),
  VOLCENGINE_TRANSLATE_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  VOLCENGINE_TRANSLATE_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  WEB_ORIGINS: z.string().min(1).default('http://localhost:4173,http://127.0.0.1:4173'),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>
let environmentFileLoaded = false

function loadEnvironmentFile() {
  if (environmentFileLoaded || typeof process.loadEnvFile !== 'function') return
  environmentFileLoaded = true
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '..', '.env')]
  const file = candidates.find((candidate) => existsSync(candidate))
  if (file) process.loadEnvFile(file)
}

export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  if (source === process.env) loadEnvironmentFile()
  return ServerEnvSchema.parse(source)
}
