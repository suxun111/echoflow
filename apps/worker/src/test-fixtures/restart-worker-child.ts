import { randomUUID } from 'node:crypto'
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import { createPlaybackProcessor, type PlaybackJob, type ProbeResult } from '../processors/playback'

const database = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const queueName = process.env.G2_TEST_QUEUE_NAME!
const queue = new Queue<PlaybackJob>(queueName, { connection })
const storage = new MinioStorageProvider({
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'online_learning',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'online_learning_secret',
  bucket: process.env.MINIO_BUCKET!,
})
const hangingProbe = async (): Promise<ProbeResult> => new Promise(() => undefined)
const processPlayback = createPlaybackProcessor({
  database, storage, workerId: `restart-child-${randomUUID()}`,
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe', ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ...(process.env.G2_TEST_HANG_PROBE === 'true' ? { probe: hangingProbe } : {}),
})
const worker = new Worker<PlaybackJob>(queueName, (job) => processPlayback(job.data), {
  connection, concurrency: 1, lockDuration: 2_000, stalledInterval: 1_000,
})

worker.on('ready', () => console.log(JSON.stringify({ type: 'restart_worker_ready' })))
worker.on('completed', (job) => console.log(JSON.stringify({ type: 'restart_worker_completed', jobId: job.id })))
worker.on('failed', (job, error) => console.error(JSON.stringify({ type: 'restart_worker_failed', jobId: job?.id, message: error.message })))

async function shutdown() {
  await worker.close(true)
  await queue.close()
  await connection.quit()
  await database.$disconnect()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
