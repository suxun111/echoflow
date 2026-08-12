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
      if (upload.providerUploadId) {
        try {
          await storage.abortMultipartUpload(upload.objectKey, upload.providerUploadId)
        } catch (error) {
          if (!isStorageCode(error, 'NoSuchUpload')) throw error
          try {
            await storage.remove(upload.objectKey)
          } catch (removeError) {
            if (!isStorageCode(removeError, 'NoSuchKey')) throw removeError
          }
        }
      }
      const changed = await database.uploadSession.updateMany({
        where: { id: upload.id, status: { in: ['CREATED', 'UPLOADING', 'VERIFYING'] }, expiresAt: { lte: now } },
        data: { status: 'EXPIRED', abortedAt: now },
      })
      cleaned += changed.count
    } catch {
      failed += 1
    }
  }
  return { scanned: expired.length, cleaned, failed }
}
