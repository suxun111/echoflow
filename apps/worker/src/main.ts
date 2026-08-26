import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { loadServerEnv } from '@online-learning/config'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import { HttpMossAdapter } from './moss/adapter'
import { createPlaybackProcessor, type PlaybackJob } from './processors/playback'
import { cancelExternalTranscriptJobs, createTranscriptProcessor } from './processors/transcript'
import { cleanupExpiredUploads } from './processors/upload-cleanup'
import { cleanupTranscriptObjects } from './processors/transcript-cleanup'
import {
  FakeProofDigestService,
  FakeStrictAssessmentInputProvider,
  InMemoryAlignmentAdapter,
} from './handoff'
import {
  enqueuePendingTranscriptCancellations, enqueueRecoverableRuns, enqueueRecoverableTranscriptRuns, ensureTranscriptRuns,
  publishPendingOutbox, type MediaQueueJob,
} from './outbox'

const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')

const env = loadServerEnv()
const database = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
const queue = new Queue<MediaQueueJob>('echoflow-media', { connection })
const workerId = `media-${randomUUID()}`
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
  transcriptEnabled: env.MOSS_ENABLED,
})
const moss = env.MOSS_ENABLED ? new HttpMossAdapter({ env }) : null
const processTranscript = moss ? createTranscriptProcessor({
  database,
  storage,
  workerId,
  env,
  moss,
  // F2: v2 HANDOFF_EVIDENCING is routed to an injected in-memory alignment
  // Fake + a fake proof digest; no real MFA/model/network is contacted here.
  handoff: {
    alignment: new InMemoryAlignmentAdapter(),
    proof: new FakeProofDigestService(Buffer.from('echoflow-f2-fake-key'), 'f2-fake-v1'),
    assessment: new FakeStrictAssessmentInputProvider(),
    methodDigest: hex64('mfa-3.3.9'),
    modelDigest: hex64('english_mfa-3.1.0'),
    configDigest: hex64('default'),
  },
}) : null

const worker = new Worker<MediaQueueJob>('echoflow-media', async (job) => {
  if (job.name === 'media.upload_verified') return processPlayback(job.data as PlaybackJob)
  if (!processTranscript || !moss) return { skipped: true, reason: 'moss_disabled' }
  if (job.name === 'media.transcript_cancel_requested') {
    return cancelExternalTranscriptJobs(database, moss, job.data, new Date(), env.MOSS_JOB_TIMEOUT_SECONDS * 1000)
  }
  return processTranscript(job.data)
}, {
  connection,
  concurrency: 2,
})

async function publishPending() {
  if (env.MOSS_ENABLED) await ensureTranscriptRuns(database)
  await publishPendingOutbox(database, queue, env.MOSS_ENABLED)
  await enqueueRecoverableRuns(database, queue)
  if (env.MOSS_ENABLED) {
    await enqueueRecoverableTranscriptRuns(database, queue)
    await enqueuePendingTranscriptCancellations(database, queue)
  }
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
const transcriptCleanupInterval = setInterval(() => void cleanupTranscriptObjects(database, storage).then((result) => {
  if (result.cleaned || result.failed) console.log(JSON.stringify({ type: 'transcript_object_cleanup', ...result }))
}).catch((error) => {
  console.error(JSON.stringify({ type: 'transcript_object_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
}), 60_000)
void cleanupTranscriptObjects(database, storage).catch((error) => {
  console.error(JSON.stringify({ type: 'transcript_object_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
})

worker.on('completed', (job) => console.log(JSON.stringify({ type: 'media_job_completed', jobId: job.id })))
worker.on('failed', (job, error) => console.error(JSON.stringify({ type: 'media_job_failed', jobId: job?.id, message: error.message })))

async function shutdown() {
  clearInterval(interval)
  clearInterval(cleanupInterval)
  clearInterval(transcriptCleanupInterval)
  await worker.close()
  await queue.close()
  await connection.quit()
  await database.$disconnect()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
