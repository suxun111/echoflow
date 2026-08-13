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
    && ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(String((error as { code?: unknown }).code))
}

export async function cleanupTranscriptObjects(
  database: PrismaClient,
  storage: MultipartStorageProvider,
  now = new Date(),
) {
  await storage.ensureBucket()
  await storage.ensureVersioning()
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
    try {
      const purged = await database.$transaction(async (transaction) => {
        const objectIdentity = `${object.bucket}:${object.objectKey}`
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
        const current = await transaction.mediaObject.findUnique({ where: { id: object.id } })
        if (!current || current.purgedAt) return false
        const currentRunId = metadataRunId(current.metadata)
        if (currentRunId !== processingRunId) return false
        const run = await transaction.processingRun.findFirst({
          where: { id: processingRunId, mediaAssetId: current.mediaAssetId }, select: { status: true },
        })
        if (!run || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return false
        const retentionMs = current.kind === 'ASR_RAW'
          ? 7 * 24 * 60 * 60_000
          : 24 * 60 * 60_000
        if (current.createdAt.getTime() > now.getTime() - retentionMs) return false
        if (!current.deletedAt) {
          const tombstoned = await transaction.mediaObject.updateMany({
            where: { id: current.id, versionId: current.versionId, deletedAt: null, purgedAt: null },
            data: { deletedAt: now },
          })
          if (tombstoned.count !== 1) return false
        }
        let removedVersionId = current.versionId
        if (removedVersionId) {
          try {
            await storage.remove(current.objectKey, removedVersionId)
          } catch (error) {
            if (!isMissingObject(error)) throw error
          }
        } else {
          try {
            const latest = await storage.statObject(current.objectKey, null)
            if (!latest.versionId) throw new Error('object_store_version_required')
            const tracked = await transaction.mediaObject.findFirst({
              where: {
                id: { not: current.id },
                bucket: current.bucket,
                objectKey: current.objectKey,
                versionId: latest.versionId,
              },
              select: { id: true, purgedAt: true },
            })
            if (tracked?.purgedAt) {
              await storage.remove(current.objectKey, latest.versionId)
            } else if (!tracked) {
              await storage.remove(current.objectKey, latest.versionId)
              removedVersionId = latest.versionId
            } else {
              return false
            }
          } catch (error) {
            if (isMissingObject(error)) return false
            throw error
          }
        }
        const finalized = await transaction.mediaObject.updateMany({
          where: { id: current.id, versionId: current.versionId, purgedAt: null },
          data: { versionId: removedVersionId, purgedAt: now },
        })
        return finalized.count === 1
      }, { maxWait: 10 * 60_000, timeout: 30 * 60_000 })
      if (purged) cleaned += 1
    } catch (error) {
      failed += 1
    }
  }
  return { scanned: candidates.length, cleaned, failed }
}
