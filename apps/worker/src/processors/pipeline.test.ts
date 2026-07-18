import { describe, expect, it } from 'vitest'
import type { ProcessingJob } from '@online-learning/contracts'
import { processPipelineJob } from './pipeline'

const job: ProcessingJob = { id: 'job-1', uploadId: 'upload-1', type: 'transcribe', status: 'queued', progress: 0, error: null, updatedAt: new Date().toISOString() }

describe('media pipeline', () => {
  it('completes a simulated job', async () => { const result = await processPipelineJob(job, { processedKeys: new Set() }); expect(result.status).toBe('completed'); expect(result.progress).toBe(100) })
  it('is idempotent for an upload stage', async () => { const processedKeys = new Set<string>(); await processPipelineJob(job, { processedKeys }); const repeated = await processPipelineJob(job, { processedKeys }); expect(repeated.skipped).toBe(true) })
})
