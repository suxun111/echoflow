import type { PrismaClient } from '@online-learning/database'
import type { MultipartStorageProvider } from '@online-learning/storage'

function isStorageCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

export async function cleanupExpiredUploads(
  database: PrismaClient,
  storage: MultipartStorageProvider,
  now = new Date(),
) {
  const expired = await database.uploadSession.findMany({
    where: { status: { in: ['CREATED', 'UPLOADING', 'VERIFYING'] }, expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  })
  let cleaned = 0
  let failed = 0
  for (const upload of expired) {
    try {
      const changed = await database.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${upload.id}, 0))`
        const current = await transaction.uploadSession.findUnique({ where: { id: upload.id } })
        if (!current || !['CREATED', 'UPLOADING', 'VERIFYING'].includes(current.status) || current.expiresAt > now) return 0
        if (current.providerUploadId) {
          try {
            await storage.abortMultipartUpload(current.objectKey, current.providerUploadId)
          } catch (error) {
            if (!isStorageCode(error, 'NoSuchUpload')) throw error
            try {
              await storage.remove(current.objectKey)
            } catch (removeError) {
              if (!isStorageCode(removeError, 'NoSuchKey')) throw removeError
            }
          }
        }
        const result = await transaction.uploadSession.updateMany({
          where: { id: current.id, status: { in: ['CREATED', 'UPLOADING', 'VERIFYING'] }, expiresAt: { lte: now } },
          data: { status: 'EXPIRED', abortedAt: now },
        })
        return result.count
      }, { maxWait: 10_000, timeout: 60_000 })
      cleaned += changed
    } catch {
      failed += 1
    }
  }
  return { scanned: expired.length, cleaned, failed }
}
