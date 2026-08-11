import { loadEnvFile } from 'node:process'
import { Worker } from 'bullmq'
import type { ProcessingJob } from '@online-learning/contracts'
import { processPipelineJob } from './processors/pipeline'

try { loadEnvFile() } catch {}

const redisUrl = process.env.REDIS_URL?.trim()
const processedKeys = new Set<string>()

if (!redisUrl) {
  console.error('Worker cannot start: REDIS_URL is not configured.')
  process.exitCode = 1
} else {
  const worker = new Worker<ProcessingJob>('online-learning-media', (job) => processPipelineJob(job.data, { processedKeys }), { connection: { url: redisUrl } })
  worker.on('completed', (job) => console.log(`Completed media job ${job.id}`))
  worker.on('failed', (job, error) => console.error(`Failed media job ${job?.id}: ${error.message}`))
  worker.on('error', (error) => console.error(`Worker connection error: ${error.message}`))
}
