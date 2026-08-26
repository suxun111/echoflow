import { Prisma, type PrismaClient } from '@online-learning/database'
import type { MultipartStorageProvider } from '@online-learning/storage'
import { isTranscriptObjectCleanupEligible, TRANSCRIPT_OBJECT_KINDS } from '../transcript/object-lifecycle'

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
      kind: { in: [...TRANSCRIPT_OBJECT_KINDS] },
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
      const reserved = await database.$transaction(async (transaction) => {
        const objectIdentity = `${object.bucket}:${object.objectKey}`
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
        const current = await transaction.mediaObject.findUnique({ where: { id: object.id } })
        if (!current || current.purgedAt) return null
        const currentRunId = metadataRunId(current.metadata)
        if (currentRunId !== processingRunId) return null
        const run = await transaction.processingRun.findFirst({
          where: { id: processingRunId, mediaAssetId: current.mediaAssetId }, select: { status: true },
        })
        if (!isTranscriptObjectCleanupEligible(current, run, now)) return null
        if (!current.deletedAt) {
          const tombstoned = await transaction.mediaObject.updateMany({
            where: { id: current.id, versionId: current.versionId, deletedAt: null, purgedAt: null },
            data: { deletedAt: now },
          })
          if (tombstoned.count !== 1) return null
        }
        return {
          id: current.id, bucket: current.bucket, objectKey: current.objectKey,
          versionId: current.versionId,
        }
      }, { maxWait: 10_000, timeout: 30_000 })
      if (!reserved) continue

      let removalVersionId = reserved.versionId
      if (!removalVersionId) {
        try {
          const latest = await storage.statObject(reserved.objectKey, null)
          if (!latest.versionId) throw new Error('object_store_version_required')
          const identity = await database.$transaction(async (transaction) => {
            const objectIdentity = `${reserved.bucket}:${reserved.objectKey}`
            await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
            const current = await transaction.mediaObject.findFirst({
              where: { id: reserved.id, versionId: null, deletedAt: { not: null }, purgedAt: null },
            })
            if (!current) return { versionId: null, finalized: false }
            const tracked = await transaction.mediaObject.findFirst({
              where: {
                id: { not: current.id }, bucket: current.bucket,
                objectKey: current.objectKey, versionId: latest.versionId,
                purgedAt: null,
              },
              select: { id: true },
            })
            if (tracked) {
              const finalized = await transaction.mediaObject.updateMany({
                where: { id: current.id, versionId: null, deletedAt: { not: null }, purgedAt: null },
                data: { purgedAt: now },
              })
              return { versionId: null, finalized: finalized.count === 1 }
            }
            const identified = await transaction.mediaObject.updateMany({
              where: { id: current.id, versionId: null, deletedAt: { not: null }, purgedAt: null },
              data: { versionId: latest.versionId },
            })
            return { versionId: identified.count === 1 ? latest.versionId : null, finalized: false }
          }, { maxWait: 10_000, timeout: 30_000 })
          if (identity.finalized) {
            cleaned += 1
            continue
          }
          removalVersionId = identity.versionId
          if (!removalVersionId) continue
        } catch (error) {
          if (!isMissingObject(error)) throw error
          const finalized = await database.$transaction(async (transaction) => {
            const objectIdentity = `${reserved.bucket}:${reserved.objectKey}`
            await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
            return transaction.mediaObject.updateMany({
              where: { id: reserved.id, versionId: null, deletedAt: { not: null }, purgedAt: null },
              data: { purgedAt: now },
            })
          }, { maxWait: 10_000, timeout: 30_000 })
          if (finalized.count === 1) cleaned += 1
          continue
        }
      }

      try {
        await storage.remove(reserved.objectKey, removalVersionId)
      } catch (error) {
        if (!isMissingObject(error)) throw error
      }
      const finalized = await database.$transaction(async (transaction) => {
        const objectIdentity = `${reserved.bucket}:${reserved.objectKey}`
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectIdentity}, 0))`
        return transaction.mediaObject.updateMany({
          where: {
            id: reserved.id, versionId: removalVersionId,
            deletedAt: { not: null }, purgedAt: null,
          },
          data: { purgedAt: now },
        })
      }, { maxWait: 10_000, timeout: 30_000 })
      if (finalized.count === 1) cleaned += 1
    } catch (error) {
      failed += 1
    }
  }
  return { scanned: candidates.length, cleaned, failed }
}
