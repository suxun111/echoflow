import { Worker } from 'bullmq'
import type { ProcessingJob } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'
import { processPipelineJob } from './processors/pipeline'

const env = loadServerEnv()

if (!process.env.REDIS_URL && env.NODE_ENV !== 'production') {
  console.log('Worker skeleton ready. Set REDIS_URL to consume online-learning-media jobs.')
} else {
  const database = new DatabaseService()
  const worker = new Worker<ProcessingJob>(env.MEDIA_QUEUE_NAME, async (job) => {
    const markProcessing = await database.processingJob.updateMany({ where: { id: job.data.id, status: { in: ['QUEUED', 'PROCESSING', 'FAILED'] } }, data: { status: 'PROCESSING', attempts: { increment: 1 }, error: null } })
    if (!markProcessing.count) return processPipelineJob(job.data, { isProcessed: async () => true })
    try {
      return await processPipelineJob(job.data, {
        isProcessed: async () => {
          const current = await database.processingJob.findUnique({ where: { id: job.data.id }, select: { status: true } })
          return current?.status === 'COMPLETED' || current?.status === 'REVIEW'
        },
        update: async (update) => {
          await database.processingJob.update({ where: { id: job.data.id }, data: { status: update.status.toUpperCase() as 'PROCESSING' | 'REVIEW' | 'COMPLETED', progress: update.progress, error: update.error, ...(update.output ? { payload: update.output as never } : {}) } })
        },
      })
    } catch (error) {
      await database.processingJob.update({ where: { id: job.data.id }, data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
  }, { connection: { url: env.REDIS_URL }, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) })

  worker.on('completed', (job) => console.log(JSON.stringify({ level: 'info', event: 'media_job_completed', jobId: job.id, durationMs: job.processedOn ? Date.now() - job.processedOn : undefined })))
  worker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', event: 'media_job_failed', jobId: job?.id, error: error.message })))
  worker.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'media_worker_error', error: error.message })))

  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ level: 'info', event: 'media_worker_shutdown', signal }))
    await worker.close()
    await database.onModuleDestroy()
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
}
