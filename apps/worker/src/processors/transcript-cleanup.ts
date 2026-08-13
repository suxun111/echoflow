import { Prisma, type PrismaClient } from '@online-learning/database'
import type { MultipartStorageProvider } from '@online-learning/storage'

function metadataRunId(value: Prisma.JsonValue | null) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).processingRunId === 'string'
    ? (value as Record<string, string>).processingRunId
    : null
}

function isMissingObject(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['NoSuchKey', 'NoSuchVersion'].includes(String((error as { code?: unknown }).code))
}

export async function cleanupTranscriptObjects(
  database: PrismaClient,
  storage: MultipartStorageProvider,
  now = new Date(),
) {
  const candidates = await database.mediaObject.findMany({
    where: {
      kind: { in: ['NORMALIZED_AUDIO', 'AUDIO_CHUNK', 'ASR_RAW'] },
      purgedAt: null,
      OR: [
        { deletedAt: { not: null } },
        { deletedAt: null, createdAt: { lte: new Date(now.getTime() - 24 * 60 * 60_000) } },
      ],
    },
    orderBy: { createdAt: 'asc' }, take: 100,
  })
  let cleaned = 0
  let failed = 0
  for (const object of candidates) {
    const processingRunId = metadataRunId(object.metadata)
    if (!processingRunId) continue
    const tombstone = await database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${object.mediaAssetId}, 0))`
      const run = await transaction.processingRun.findFirst({
        where: { id: processingRunId, mediaAssetId: object.mediaAssetId }, select: { status: true },
      })
      if (!run || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return false
      const retentionMs = object.kind === 'ASR_RAW'
        ? 7 * 24 * 60 * 60_000
        : 24 * 60 * 60_000
      if (object.createdAt.getTime() > now.getTime() - retentionMs) return false
      if (object.deletedAt) return true
      const changed = await transaction.mediaObject.updateMany({ where: { id: object.id, deletedAt: null, purgedAt: null }, data: { deletedAt: now } })
      return changed.count === 1
    })
    if (!tombstone) continue
    try {
      await storage.remove(object.objectKey, object.versionId)
      await database.mediaObject.updateMany({ where: { id: object.id, purgedAt: null }, data: { purgedAt: now } })
      cleaned += 1
    } catch (error) {
      if (isMissingObject(error)) {
        await database.mediaObject.updateMany({ where: { id: object.id, purgedAt: null }, data: { purgedAt: now } })
        cleaned += 1
        continue
      }
      failed += 1
    }
  }
  return { scanned: candidates.length, cleaned, failed }
}
