import { Worker } from 'bullmq'
import { loadServerEnv } from '@online-learning/config'
import { processPipelineJob, type MediaQueueJob } from './processors/pipeline'

const env = loadServerEnv()
const mossUrl = new URL(env.MOSS_SERVICE_URL)
const mossAddress = `${mossUrl.protocol}//${mossUrl.hostname}${mossUrl.port ? `:${mossUrl.port}` : ''}`
console.log(`MOSS configured at ${mossAddress}; request timeout ${env.MOSS_REQUEST_TIMEOUT_MS}ms; retries ${env.MOSS_MAX_RETRIES}`)
if (env.NODE_ENV === 'production' && ['localhost', '127.0.0.1', '::1'].includes(mossUrl.hostname)) {
  console.warn('MOSS_SERVICE_URL points to loopback in production; use the MOSS service name or a reachable host.')
}

const worker = new Worker<MediaQueueJob>('online-learning-media', (job) => processPipelineJob(job.data, undefined, {
  attemptsMade: job.attemptsMade,
  maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : 1,
}), {
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
