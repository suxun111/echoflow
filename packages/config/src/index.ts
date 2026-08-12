import { z } from 'zod'

const BooleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true')

export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  DATABASE_URL: z.string().startsWith('postgresql://'),
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
  CORS_ALLOWED_ORIGINS: z.string().min(1).transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_ACCESS_KEY: z.string().default('online_learning'),
  MINIO_SECRET_KEY: z.string().default('online_learning_secret'),
  MINIO_BUCKET: z.string().default('online-learning'),
}).superRefine((env, context) => {
  if (env.NODE_ENV !== 'production') return
  if (env.AUTH_EXPOSE_TEST_OTP) context.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTH_EXPOSE_TEST_OTP'], message: '生产环境禁止返回测试 OTP' })
  if (!env.REFRESH_COOKIE_SECURE) context.addIssue({ code: z.ZodIssueCode.custom, path: ['REFRESH_COOKIE_SECURE'], message: '生产 Refresh Cookie 必须启用 Secure' })
  if (env.CORS_ALLOWED_ORIGINS.some((origin) => origin === '*')) context.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ALLOWED_ORIGINS'], message: '生产 CORS 禁止通配符' })
  for (const key of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_PEPPER', 'OTP_HMAC_SECRET'] as const) {
    if (/development|replace|change-me|example/i.test(env[key])) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '生产环境禁止示例 Secret' })
  }
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>

export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  return ServerEnvSchema.parse(source)
}
