import { z } from 'zod'

const BooleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true')

export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  API_HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_PEPPER: z.string().min(32),
  OTP_HMAC_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_SESSION_TTL_SECONDS: z.coerce.number().int().min(3600).max(90 * 24 * 3600).default(30 * 24 * 3600),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  OTP_MIN_REQUEST_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(60),
  AUTH_EXPOSE_TEST_OTP: BooleanStringSchema.default('false'),
  REFRESH_COOKIE_SECURE: BooleanStringSchema.default('true'),
  CORS_ALLOWED_ORIGINS: z.string().min(1)
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(z.string().url()).min(1)),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: BooleanStringSchema.default('false'),
  MINIO_ACCESS_KEY: z.string().default('online_learning'),
  MINIO_SECRET_KEY: z.string().default('online_learning_secret'),
  MINIO_BUCKET: z.string().default('online-learning'),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().positive().max(8 * 1024 * 1024 * 1024).default(8 * 1024 * 1024 * 1024),
  UPLOAD_USER_QUOTA_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024 * 1024),
  UPLOAD_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).max(512 * 1024 * 1024).default(32 * 1024 * 1024),
  UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(3600).max(7 * 24 * 3600).default(7 * 24 * 3600),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(15 * 60),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  MOSS_ENABLED: BooleanStringSchema.default('false'),
  MOSS_BASE_URL: z.string().url().optional(),
  MOSS_API_TOKEN: z.string().min(16).optional(),
  MOSS_CALLBACK_SECRET: z.string().min(32).optional(),
  MOSS_CALLBACK_PUBLIC_URL: z.string().url().optional(),
  MOSS_MODEL_VERSION: z.string().min(1).max(128).default('moss-default'),
  MOSS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(5 * 60_000).default(30_000),
  MOSS_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(24 * 3600).default(6 * 3600),
  MOSS_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  MOSS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  MOSS_CHUNK_TARGET_SECONDS: z.coerce.number().int().min(60).max(30 * 60).default(10 * 60),
  MOSS_CHUNK_OVERLAP_SECONDS: z.coerce.number().int().min(0).max(30).default(2),
  MOSS_AUDIO_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(15 * 60),
  MOSS_CALLBACK_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(900).default(5 * 60),
  V2_TRANSCRIPT_ALLOWLIST: z.string().default('')
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1))),
  // F2 may exercise v2 only in an isolated test harness.  This flag cannot
  // turn the experimental enrollment endpoint on in a developer or production
  // process where a real media worker could be present.
  V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED: BooleanStringSchema.default('false'),
}).superRefine((env, context) => {
  if (new URL(env.DATABASE_URL).pathname === '/online_learning') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: '历史 online_learning 数据库受保护，请使用独立 echoflow 数据库' })
  }
  if (env.MOSS_ENABLED) {
    for (const key of ['MOSS_BASE_URL', 'MOSS_API_TOKEN', 'MOSS_CALLBACK_SECRET', 'MOSS_CALLBACK_PUBLIC_URL'] as const) {
      if (!env[key]) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '启用 MOSS 时必须显式配置' })
    }
  }
  if (env.V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED && env.NODE_ENV !== 'test') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED'], message: 'v2 Fake runtime 只能在测试环境启用' })
  }
  if (env.NODE_ENV !== 'production') return
  if (env.AUTH_EXPOSE_TEST_OTP) context.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_EXPOSE_TEST_OTP'], message: '生产环境禁止返回测试 OTP' })
  if (!env.REFRESH_COOKIE_SECURE) context.addIssue({ code: z.ZodIssueCode.custom, path: ['REFRESH_COOKIE_SECURE'], message: '生产 Refresh Cookie 必须启用 Secure' })
  if (!env.MINIO_USE_SSL) context.addIssue({ code: z.ZodIssueCode.custom, path: ['MINIO_USE_SSL'], message: '生产对象存储连接必须启用 TLS' })
  if (env.CORS_ALLOWED_ORIGINS.some((origin) => origin === '*')) context.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ALLOWED_ORIGINS'], message: '生产 CORS 禁止通配符' })
  for (const key of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_PEPPER', 'OTP_HMAC_SECRET'] as const) {
    if (/development|replace|change-me|example/i.test(env[key])) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '生产环境禁止示例 Secret' })
  }
  for (const key of ['MOSS_API_TOKEN', 'MOSS_CALLBACK_SECRET'] as const) {
    const value = env[key]
    if (env.MOSS_ENABLED && value && /development|replace|change-me|example/i.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '生产环境禁止示例 MOSS Secret' })
    }
  }
  if (env.MOSS_ENABLED) {
    for (const key of ['MOSS_BASE_URL', 'MOSS_CALLBACK_PUBLIC_URL'] as const) {
      const value = env[key]
      if (value && new URL(value).protocol !== 'https:') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '生产 MOSS 连接必须使用 HTTPS' })
      }
    }
  }
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>

export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  return ServerEnvSchema.parse(source)
}
