import { randomUUID } from 'node:crypto'
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { loadServerEnv } from '@online-learning/config'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import { createPlaybackProcessor, type PlaybackJob } from './processors/playback'
import { cleanupExpiredUploads } from './processors/upload-cleanup'
import { enqueueRecoverableRuns, publishPendingOutbox } from './outbox'

const env = loadServerEnv()
const database = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
const queue = new Queue<PlaybackJob>('echoflow-media', { connection })
const workerId = `playback-${randomUUID()}`
const storage = new MinioStorageProvider({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  bucket: env.MINIO_BUCKET,
})
const processPlayback = createPlaybackProcessor({
  database,
  storage,
  workerId,
  ffprobePath: env.FFPROBE_PATH,
  ffmpegPath: env.FFMPEG_PATH,
})

const worker = new Worker<PlaybackJob>('echoflow-media', async (job) => processPlayback(job.data), {
  connection,
  concurrency: 2,
})

async function publishPending() {
  await publishPendingOutbox(database, queue)
  await enqueueRecoverableRuns(database, queue)
}

const interval = setInterval(() => void publishPending().catch((error) => {
  console.error(JSON.stringify({ type: 'outbox_publish_failed', message: error instanceof Error ? error.message : 'unknown' }))
}), 2_000)
void publishPending().catch((error) => {
  console.error(JSON.stringify({ type: 'outbox_publish_failed', message: error instanceof Error ? error.message : 'unknown' }))
})
const cleanupInterval = setInterval(() => void cleanupExpiredUploads(database, storage).then((result) => {
  if (result.cleaned || result.failed) console.log(JSON.stringify({ type: 'expired_upload_cleanup', ...result }))
}).catch((error) => {
  console.error(JSON.stringify({ type: 'expired_upload_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
}), 60_000)
void cleanupExpiredUploads(database, storage).catch((error) => {
  console.error(JSON.stringify({ type: 'expired_upload_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
})

worker.on('completed', (job) => console.log(JSON.stringify({ type: 'media_job_completed', jobId: job.id })))
worker.on('failed', (job, error) => console.error(JSON.stringify({ type: 'media_job_failed', jobId: job?.id, message: error.message })))

async function shutdown() {
  clearInterval(interval)
  clearInterval(cleanupInterval)
  await worker.close()
  await queue.close()
  await connection.quit()
  await database.$disconnect()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
