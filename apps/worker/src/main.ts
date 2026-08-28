import { createHash, randomUUID } from 'node:crypto'
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
import { createMediaJobHandler } from './media-job-handler'
import { InMemoryAlignmentAdapter } from './handoff/alignment'
import { FakeStrictAssessmentInputProvider } from './handoff/evidencing'
import { FakeProofDigestService } from './handoff/proof'
import { advanceV2HandoffEvidencing, cancelV2HandoffEvidencing } from './handoff/runtime'
import { workerLifecycleLogEntry } from './runtime-log'
import {
  enqueuePendingTranscriptCancellations, enqueueRecoverableRuns, enqueueRecoverableTranscriptRuns, ensureTranscriptRuns,
  publishPendingOutbox, type MediaQueueJob,
} from './outbox'

const env = loadServerEnv()
const database = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
const workerId = `media-${randomUUID()}`
// F2's v2 route is intentionally available only to the test harness.  This
// flag is schema-rejected outside NODE_ENV=test, and the injected adapters
// below are in-memory only: no MOSS, media, object storage or network path.
const v2FakeRuntimeEnabled = env.NODE_ENV === 'test' && env.V2_TRANSCRIPT_FAKE_RUNTIME_ENABLED
// Test-only v2 uses a separate queue. It must never observe an existing v1
// job from the shared media queue.
const queueName = v2FakeRuntimeEnabled ? 'echoflow-v2-fake-runtime' : 'echoflow-media'
const queue = new Queue<MediaQueueJob>(queueName, { connection })
// A test-only v2 worker must not opportunistically start the legacy MOSS
// pipeline or either storage cleanup loop.  It owns only PostgreSQL metadata
// plus in-memory Fakes.
const mossRuntimeEnabled = env.MOSS_ENABLED && !v2FakeRuntimeEnabled
const storage = v2FakeRuntimeEnabled ? null : new MinioStorageProvider({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  bucket: env.MINIO_BUCKET,
})
const processPlayback = storage ? createPlaybackProcessor({
  database,
  storage,
  workerId,
  ffprobePath: env.FFPROBE_PATH,
  ffmpegPath: env.FFMPEG_PATH,
  transcriptEnabled: mossRuntimeEnabled,
}) : null
const moss = mossRuntimeEnabled ? new HttpMossAdapter({ env }) : null
const processTranscript = moss && storage ? createTranscriptProcessor({
  database,
  storage,
  workerId,
  env,
  moss,
}) : null
const v2Runtime = v2FakeRuntimeEnabled ? {
  database,
  assessment: new FakeStrictAssessmentInputProvider(),
  alignment: new InMemoryAlignmentAdapter(),
  proof: new FakeProofDigestService(Buffer.alloc(32, 7), 'f2-runtime-test-only'),
  methodDigest: createHash('sha256').update('f2-fake-method').digest('hex'),
  modelDigest: createHash('sha256').update('f2-fake-model').digest('hex'),
  configDigest: createHash('sha256').update('f2-fake-config').digest('hex'),
  workerId: `${workerId}:v2-fake`,
} : null

const handleMediaJob = createMediaJobHandler({
  v2FakeOnly: v2FakeRuntimeEnabled,
  processPlayback: (job) => {
    if (!processPlayback) return Promise.resolve({ skipped: true, reason: 'v2_fake_runtime_isolated' })
    return processPlayback(job)
  },
  processTranscript: (job) => {
    if (!processTranscript) return Promise.resolve({ skipped: true, reason: 'moss_disabled' })
    return processTranscript(job)
  },
  cancelTranscript: (job) => {
    if (!moss) return Promise.resolve({ skipped: true, reason: 'moss_disabled' })
    return cancelExternalTranscriptJobs(database, moss, job, new Date(), env.MOSS_JOB_TIMEOUT_SECONDS * 1000)
  },
  resolvePipelineVersion: async (job) => {
    const run = await database.processingRun.findFirst({
      where: { id: job.processingRunId, mediaAssetId: job.mediaAssetId },
      select: { pipelineVersion: true },
    })
    return run?.pipelineVersion ?? null
  },
  resolveV2Job: async ({ v2JobHandle }) => {
    const run = await database.processingRun.findFirst({
      where: { requestId: v2JobHandle, pipelineVersion: 'g3-transcript-v2' },
      select: { id: true, mediaAssetId: true },
    })
    return run ? { processingRunId: run.id, mediaAssetId: run.mediaAssetId } : null
  },
  processV2Transcript: async (job) => v2Runtime
    ? { ...(await advanceV2HandoffEvidencing(v2Runtime, job)) }
    : { skipped: true, reason: 'v2_fake_runtime_disabled' },
  cancelV2Transcript: async (job) => v2Runtime
    ? { ...(await cancelV2HandoffEvidencing(v2Runtime, job)) }
    : { skipped: true, reason: 'v2_fake_runtime_disabled' },
})

const worker = new Worker<MediaQueueJob>(queueName, (job) => handleMediaJob({ name: job.name, data: job.data }), {
  connection,
  concurrency: v2FakeRuntimeEnabled ? 1 : 2,
})

async function publishPending() {
  if (v2FakeRuntimeEnabled) {
    await publishPendingOutbox(database, queue, false, true)
    await enqueueRecoverableTranscriptRuns(database, queue, false, true)
    await enqueuePendingTranscriptCancellations(database, queue, false, true)
    return
  }
  if (mossRuntimeEnabled) await ensureTranscriptRuns(database)
  await publishPendingOutbox(database, queue, mossRuntimeEnabled, v2FakeRuntimeEnabled)
  await enqueueRecoverableRuns(database, queue)
  if (mossRuntimeEnabled || v2FakeRuntimeEnabled) {
    await enqueueRecoverableTranscriptRuns(database, queue, mossRuntimeEnabled, v2FakeRuntimeEnabled)
    await enqueuePendingTranscriptCancellations(database, queue, mossRuntimeEnabled, v2FakeRuntimeEnabled)
  }
}

const interval = setInterval(() => void publishPending().catch(() => {
  console.error(JSON.stringify({ type: 'outbox_publish_failed', code: 'worker_operation_failed' }))
}), 2_000)
void publishPending().catch(() => {
  console.error(JSON.stringify({ type: 'outbox_publish_failed', code: 'worker_operation_failed' }))
})
const cleanupInterval = storage ? setInterval(() => void cleanupExpiredUploads(database, storage).then((result) => {
  if (result.cleaned || result.failed) console.log(JSON.stringify({ type: 'expired_upload_cleanup', ...result }))
}).catch((error) => {
  console.error(JSON.stringify({ type: 'expired_upload_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
}), 60_000) : null
if (storage) void cleanupExpiredUploads(database, storage).catch((error) => {
  console.error(JSON.stringify({ type: 'expired_upload_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
})
const transcriptCleanupInterval = storage ? setInterval(() => void cleanupTranscriptObjects(database, storage).then((result) => {
  if (result.cleaned || result.failed) console.log(JSON.stringify({ type: 'transcript_object_cleanup', ...result }))
}).catch((error) => {
  console.error(JSON.stringify({ type: 'transcript_object_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
}), 60_000) : null
if (storage) void cleanupTranscriptObjects(database, storage).catch((error) => {
  console.error(JSON.stringify({ type: 'transcript_object_cleanup_failed', message: error instanceof Error ? error.message : 'unknown' }))
})

worker.on('completed', (job) => console.log(JSON.stringify(workerLifecycleLogEntry({
  outcome: 'completed',
  route: v2FakeRuntimeEnabled ? 'v2_fake' : 'legacy',
  eventType: job.name,
  jobId: job.id,
}))))
worker.on('failed', (job) => console.error(JSON.stringify(workerLifecycleLogEntry({
  outcome: 'failed',
  route: v2FakeRuntimeEnabled ? 'v2_fake' : 'legacy',
  eventType: job?.name,
  jobId: job?.id,
}))))

async function shutdown() {
  clearInterval(interval)
  if (cleanupInterval) clearInterval(cleanupInterval)
  if (transcriptCleanupInterval) clearInterval(transcriptCleanupInterval)
  await worker.close()
  await queue.close()
  await connection.quit()
  await database.$disconnect()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
