export {
  PrismaClient,
  Prisma,
  UserRole,
  UserStatus,
  OtpPurpose,
  SourceType,
  UploadStatus,
  MediaAssetStatus,
  MediaObjectKind,
  ProcessingStatus,
  ProcessingStage,
  OutboxStatus,
  TranscriptStatus,
  LessonStatus,
} from '@prisma/client'
export type { User } from '@prisma/client'

export const databasePackage = {
  provider: 'postgresql',
  schemaPath: 'packages/database/prisma/schema.prisma',
} as const

export type DatabaseRecordId = string
export type DatabaseReadiness = { configured: boolean; provider: 'postgresql'; message: string }

export function getDatabaseReadiness(databaseUrl = process.env.DATABASE_URL): DatabaseReadiness {
  return databaseUrl
    ? { configured: true, provider: 'postgresql', message: 'DATABASE_URL is configured.' }
    : { configured: false, provider: 'postgresql', message: 'DATABASE_URL is missing.' }
}
