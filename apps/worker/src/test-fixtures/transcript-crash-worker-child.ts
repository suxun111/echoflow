import { randomUUID } from 'node:crypto'
import type { ServerEnv } from '@online-learning/config'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider, type MultipartStorageProvider } from '@online-learning/storage'
import { FakeMossAdapter } from '../moss/fake-adapter'
import { createTranscriptProcessor } from '../processors/transcript'

const database = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
const baseStorage = new MinioStorageProvider({
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'online_learning',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'online_learning_secret',
  bucket: process.env.MINIO_BUCKET!,
})
const crashPoint = process.env.G3_TEST_CRASH_POINT ?? 'before-upload'
const env = {
  FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
  MOSS_MODEL_VERSION: 'fake-moss-v1',
  MOSS_CHUNK_TARGET_SECONDS: 60,
  MOSS_CHUNK_OVERLAP_SECONDS: 2,
  MOSS_AUDIO_URL_TTL_SECONDS: 900,
  MOSS_CALLBACK_PUBLIC_URL: 'https://api.example/api/v1/integrations/moss/callback',
  MOSS_POLL_INTERVAL_SECONDS: 5,
  MOSS_JOB_TIMEOUT_SECONDS: 6 * 60 * 60,
  MOSS_MAX_ATTEMPTS: 3,
} as ServerEnv

let signalled = false
const storage = new Proxy(baseStorage, {
  get(target, property) {
    if (property === 'uploadFile') {
      return async (objectKey: string, filePath: string, contentType: string) => {
        if (!objectKey.endsWith('/normalized.wav')) return target.uploadFile(objectKey, filePath, contentType)
        if (crashPoint === 'after-upload') await target.uploadFile(objectKey, filePath, contentType)
        if (!signalled) {
          signalled = true
          console.log(JSON.stringify({ type: 'g3_crash_point_reached', crashPoint }))
        }
        return new Promise(() => undefined)
      }
    }
    const value = target[property as keyof MinioStorageProvider]
    return typeof value === 'function' ? value.bind(target) : value
  },
}) as MultipartStorageProvider

const processor = createTranscriptProcessor({
  database, storage, moss: new FakeMossAdapter(), env,
  workerId: `g3-crash-child-${randomUUID()}`,
})

void processor({
  mediaAssetId: process.env.G3_TEST_MEDIA_ASSET_ID!,
  processingRunId: process.env.G3_TEST_PROCESSING_RUN_ID!,
}).then((result) => {
  console.log(JSON.stringify({ type: 'g3_crash_child_completed', result }))
}).catch((error) => {
  console.error(JSON.stringify({ type: 'g3_crash_child_failed', message: error instanceof Error ? error.message : 'unknown' }))
  process.exitCode = 1
})
