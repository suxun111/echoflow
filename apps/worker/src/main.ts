import { Worker } from 'bullmq'
import { loadServerEnv } from '@online-learning/config'
import { processPipelineJob, type MediaQueueJob } from './processors/pipeline'

const env = loadServerEnv()
const worker = new Worker<MediaQueueJob>('online-learning-media', (job) => processPipelineJob(job.data), {
  connection: { url: env.REDIS_URL },
})

worker.on('completed', (job) => console.log(`Completed media job ${job.id}`))
worker.on('failed', (job, error) => console.error(`Failed media job ${job?.id}: ${error.message}`))

async function shutdown() {
  await worker.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
