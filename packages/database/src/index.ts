import { PrismaClient } from '@prisma/client'

export const databasePackage = {
  provider: 'postgresql',
  schemaPath: 'packages/database/prisma/schema.prisma',
} as const

export type DatabaseRecordId = string
export type DatabaseReadiness = { configured: boolean; provider: 'postgresql'; message: string }

export class DatabaseService extends PrismaClient {
  async onModuleDestroy() {
    await this.$disconnect()
  }
}

export function getDatabaseReadiness(databaseUrl = process.env.DATABASE_URL): DatabaseReadiness {
  return databaseUrl
    ? { configured: true, provider: 'postgresql', message: 'DATABASE_URL is configured; run db:generate before database access.' }
    : { configured: false, provider: 'postgresql', message: 'DATABASE_URL is missing.' }
}
