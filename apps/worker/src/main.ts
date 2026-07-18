import { Worker } from 'bullmq'
import type { ProcessingJob } from '@online-learning/contracts'
import { processPipelineJob } from './processors/pipeline'

const redisUrl = process.env.REDIS_URL
const processedKeys = new Set<string>()

if (!redisUrl) {
  console.log('Worker skeleton ready. Set REDIS_URL to consume online-learning-media jobs.')
} else {
  const worker = new Worker<ProcessingJob>('online-learning-media', (job) => processPipelineJob(job.data, { processedKeys }), { connection: { url: redisUrl } })
  worker.on('completed', (job) => console.log(`Completed media job ${job.id}`))
  worker.on('failed', (job, error) => console.error(`Failed media job ${job?.id}: ${error.message}`))
}
