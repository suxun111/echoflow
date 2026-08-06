import { z } from 'zod'

const RawServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  API_PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  CORS_ORIGINS: z.string().optional(),
  MEDIA_QUEUE_NAME: z.string().min(1).optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  AUTH_MAX_ATTEMPTS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().optional(),
  MINIO_ENDPOINT: z.string().min(1).optional(),
  MINIO_PORT: z.coerce.number().int().positive().optional(),
  MINIO_USE_SSL: z.enum(['true', 'false']).optional(),
  MINIO_ACCESS_KEY: z.string().min(1).optional(),
  MINIO_SECRET_KEY: z.string().min(1).optional(),
  MINIO_BUCKET: z.string().min(1).optional(),
})

export const ServerEnvSchema = RawServerEnvSchema.superRefine((env, context) => {
  if (env.NODE_ENV !== 'production') return
  if (!env.DATABASE_URL) context.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'DATABASE_URL is required in production' })
  if (!env.REDIS_URL) context.addIssue({ code: z.ZodIssueCode.custom, path: ['REDIS_URL'], message: 'REDIS_URL is required in production' })
  if (!env.JWT_SECRET || env.JWT_SECRET === 'development-only-secret-change-me-now' || env.JWT_SECRET.startsWith('replace-with-')) context.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_SECRET'], message: 'A non-default JWT_SECRET is required in production' })
  for (const key of ['MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET'] as const) {
    if (!env[key]) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required in production` })
  }
}).transform((env) => ({
  NODE_ENV: env.NODE_ENV ?? 'development',
  API_PORT: env.API_PORT ?? 3001,
  DATABASE_URL: env.DATABASE_URL ?? 'postgresql://online_learning:online_learning@localhost:5432/online_learning',
  REDIS_URL: env.REDIS_URL ?? 'redis://localhost:6379',
  JWT_SECRET: env.JWT_SECRET ?? 'development-only-secret-change-me-now',
  CORS_ORIGINS: env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174',
  MEDIA_QUEUE_NAME: env.MEDIA_QUEUE_NAME ?? 'online-learning-media',
  JWT_ACCESS_TTL_SECONDS: env.JWT_ACCESS_TTL_SECONDS ?? 900,
  JWT_REFRESH_TTL_SECONDS: env.JWT_REFRESH_TTL_SECONDS ?? 2_592_000,
  AUTH_CODE_TTL_SECONDS: env.AUTH_CODE_TTL_SECONDS ?? 300,
  AUTH_MAX_ATTEMPTS: env.AUTH_MAX_ATTEMPTS ?? 5,
  RATE_LIMIT_WINDOW_SECONDS: env.RATE_LIMIT_WINDOW_SECONDS ?? 60,
  RATE_LIMIT_MAX_REQUESTS: env.RATE_LIMIT_MAX_REQUESTS ?? 60,
  MINIO_ENDPOINT: env.MINIO_ENDPOINT ?? 'localhost',
  MINIO_PORT: env.MINIO_PORT ?? 9000,
  MINIO_USE_SSL: env.MINIO_USE_SSL === 'true',
  MINIO_ACCESS_KEY: env.MINIO_ACCESS_KEY ?? 'online_learning',
  MINIO_SECRET_KEY: env.MINIO_SECRET_KEY ?? 'online_learning_secret',
  MINIO_BUCKET: env.MINIO_BUCKET ?? 'online-learning',
}))

export type ServerEnv = z.infer<typeof ServerEnvSchema>
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  return ServerEnvSchema.parse(source)
}
