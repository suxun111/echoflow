import { z } from 'zod'

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
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  return ServerEnvSchema.parse(source)
}
