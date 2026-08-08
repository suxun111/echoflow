import { Queue, Worker, type Job } from 'bullmq'
import { Client } from 'minio'
import type { ProcessingJob } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'
import { MossClient, MossError, type MossMediaInput } from './moss/client'
import { processPipelineJob } from './processors/pipeline'

type PersistedJob = {
  id: string
  uploadId: string
  type: string
  status: string
  progress: number
  stage: string | null
  attempts: number
  error: string | null
  errorCode: string | null
  lastAttemptAt: Date | null
  failedAt: Date | null
  payload: unknown
  updatedAt: Date
  upload?: {
    storageKey: string
    originalName: string
    contentType: string
  }
}

const queueOptions = { attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 }
const activeQueueStates = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contractStatus(value: string): ProcessingJob['status'] {
  return value.toLowerCase() as ProcessingJob['status']
}

function toContract(job: PersistedJob): ProcessingJob {
  return {
    id: job.id,
    uploadId: job.uploadId,
    type: job.type.toLowerCase() as ProcessingJob['type'],
    status: contractStatus(job.status),
    progress: job.progress,
    stage: job.stage,
    error: job.error,
    errorCode: job.errorCode,
    attempts: job.attempts,
    lastAttemptAt: job.lastAttemptAt?.toISOString() ?? null,
    failedAt: job.failedAt?.toISOString() ?? null,
    payload: isRecord(job.payload) ? job.payload : {},
    updatedAt: job.updatedAt.toISOString(),
  }
}

function failureDetails(error: unknown) {
  if (error instanceof MossError) return { code: error.code, message: error.message, retryable: error.retryable }
  return { code: 'PIPELINE_ERROR', message: error instanceof Error ? error.message : String(error), retryable: false }
}

function retryAllowed(job: Job<ProcessingJob>, retryable: boolean) {
  const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1
  return retryable && job.attemptsMade + 1 < maxAttempts
}

function mediaName(jobId: string, originalName: string) {
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160) || 'upload.bin'
  return `echoflow-${jobId}-${safeName}`
}

async function enqueue(queue: Queue<ProcessingJob>, job: ProcessingJob) {
  const existing = await queue.getJob(job.id)
  if (existing) {
    const state = await existing.getState()
    if (activeQueueStates.has(state)) return false
    await existing.remove()
  }
  await queue.add(job.type, job, { ...queueOptions, jobId: job.id })
  return true
}

async function persistFailure(database: DatabaseService, job: Job<ProcessingJob>, error: unknown) {
  const current = await database.processingJob.findUnique({ where: { id: job.data.id } }) as PersistedJob | null
  if (!current) return { status: 'failed' as const, progress: 0, stage: null, errorCode: 'PIPELINE_ERROR', error: 'Processing job not found', waiting: false }
  const details = failureDetails(error)
  const waiting = retryAllowed(job, details.retryable)
  const now = new Date()
  await database.processingJob.update({
    where: { id: current.id },
    data: {
      status: waiting ? 'WAITING_DEPENDENCY' : 'FAILED',
      progress: current.progress,
      stage: current.stage,
      error: details.message,
      errorCode: details.code,
      lastAttemptAt: now,
      failedAt: waiting ? null : now,
    },
  })
  return { status: waiting ? 'waiting_dependency' as const : 'failed' as const, progress: current.progress, stage: current.stage, errorCode: details.code, error: details.message, waiting }
}

const env = loadServerEnv()

if (!process.env.REDIS_URL && env.NODE_ENV !== 'production') {
  console.log('Worker skeleton ready. Set REDIS_URL to consume online-learning-media jobs.')
} else {
  const database = new DatabaseService()
  const moss = new MossClient({ env })
  const storage = new Client({ endPoint: env.MINIO_ENDPOINT, port: env.MINIO_PORT, useSSL: env.MINIO_USE_SSL, accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY })
  const connection = { url: env.REDIS_URL }
  const recoveryQueue = new Queue<ProcessingJob>(env.MEDIA_QUEUE_NAME, { connection })
  const worker = new Worker<ProcessingJob>(env.MEDIA_QUEUE_NAME, async (job) => {
    const staleBefore = new Date(Date.now() - Math.max(env.MOSS_REQUEST_TIMEOUT_MS * 2, env.MOSS_POLL_INTERVAL_MS * 3, 60_000))
    const markProcessing = await database.processingJob.updateMany({
      where: {
        id: job.data.id,
        OR: [
          { status: { in: ['QUEUED', 'WAITING_DEPENDENCY', 'FAILED'] } },
          { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, lastAttemptAt: new Date(), error: null, errorCode: null, failedAt: null },
    })
    if (!markProcessing.count) return processPipelineJob(job.data, { isProcessed: async () => true })

    try {
      const persisted = await database.processingJob.findUnique({
        where: { id: job.data.id },
        include: { upload: { select: { storageKey: true, originalName: true, contentType: true } } },
      }) as PersistedJob | null
      if (!persisted?.upload) throw new Error('Processing job upload was not found')
      const currentJob = toContract(persisted)
      return await processPipelineJob(currentJob, {
        moss,
        isProcessed: async () => {
          const current = await database.processingJob.findUnique({ where: { id: job.data.id }, select: { status: true } })
          return current?.status === 'COMPLETED' || current?.status === 'REVIEW'
        },
        getMossMedia: async (): Promise<MossMediaInput> => ({
          fileName: mediaName(currentJob.id, persisted.upload!.originalName),
          contentType: persisted.upload!.contentType,
          openStream: () => storage.getObject(env.MINIO_BUCKET, persisted.upload!.storageKey),
        }),
        update: async (update) => {
          const latest = await database.processingJob.findUnique({ where: { id: job.data.id }, select: { payload: true } })
          const payload = { ...(isRecord(latest?.payload) ? latest.payload : {}), ...(update.output ?? {}) }
          await database.processingJob.update({
            where: { id: job.data.id },
            data: {
              status: update.status.toUpperCase() as 'PROCESSING' | 'WAITING_DEPENDENCY' | 'REVIEW' | 'COMPLETED' | 'FAILED',
              progress: update.progress,
              stage: update.stage ?? null,
              error: update.error,
              errorCode: update.errorCode ?? null,
              payload: update.output ? payload as never : undefined,
            },
          })
        },
      })
    } catch (error) {
      const failure = await persistFailure(database, job, error)
      if (failure.waiting) throw error
      return { ...job.data, ...failure, updatedAt: new Date().toISOString(), output: {} }
    }
  }, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) })

  let recoveryInProgress = false
  const recoverWaitingJobs = async () => {
    if (recoveryInProgress) return
    recoveryInProgress = true
    try {
      const staleBefore = new Date(Date.now() - Math.max(env.MOSS_REQUEST_TIMEOUT_MS * 2, env.MOSS_POLL_INTERVAL_MS * 3, 60_000))
      const waiting = await database.processingJob.findMany({
        where: {
          OR: [
            { status: 'WAITING_DEPENDENCY' },
            { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
          ],
        },
        take: 100,
      }) as PersistedJob[]
      for (const job of waiting) await enqueue(recoveryQueue, toContract(job))
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'media_dependency_recovery_failed', error: error instanceof Error ? error.message : String(error) }))
    } finally {
      recoveryInProgress = false
    }
  }
  void recoverWaitingJobs()
  const recoveryTimer = setInterval(() => { void recoverWaitingJobs() }, env.MOSS_POLL_INTERVAL_MS)
  recoveryTimer.unref()

  worker.on('completed', (job, result) => {
    const event = result?.status === 'waiting_dependency'
      ? 'media_job_waiting_dependency'
      : result?.status === 'failed'
        ? 'media_job_failed_terminal'
        : 'media_job_completed'
    console.log(JSON.stringify({ level: 'info', event, jobId: job.id, durationMs: job.processedOn ? Date.now() - job.processedOn : undefined }))
  })
  worker.on('failed', (job, error) => {
    if (!job || job.attemptsMade < (typeof job.opts.attempts === 'number' ? job.opts.attempts : 1)) return
    void persistFailure(database, job, error).catch((persistError) => console.error(JSON.stringify({ level: 'error', event: 'media_job_failure_persist_failed', jobId: job.id, error: persistError instanceof Error ? persistError.message : String(persistError) })))
  })
  worker.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'media_worker_error', error: error.message })))

  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ level: 'info', event: 'media_worker_shutdown', signal }))
    clearInterval(recoveryTimer)
    await worker.close()
    await recoveryQueue.close()
    await database.onModuleDestroy()
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
}
