import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ProcessingJob } from '@online-learning/contracts'
import { MossError } from '../moss/client'
import { processPipelineJob } from './pipeline'

const job: ProcessingJob = { id: 'job-1', uploadId: 'upload-1', type: 'transcribe', status: 'queued', progress: 0, error: null, updatedAt: new Date().toISOString() }
const media = { fileName: 'echoflow-job-1-lesson.mp4', contentType: 'video/mp4', openStream: async () => Readable.from(['video']) }

describe('media pipeline', () => {
  it('completes a simulated job', async () => {
    const result = await processPipelineJob(job, { processedKeys: new Set() })
    expect(result.status).toBe('completed')
    expect(result.progress).toBe(100)
  })

  it('is idempotent for an upload stage', async () => {
    const processedKeys = new Set<string>()
    await processPipelineJob(job, { processedKeys })
    const repeated = await processPipelineJob(job, { processedKeys })
    expect(repeated.skipped).toBe(true)
  })

  it('does not process the same stage twice under concurrent delivery', async () => {
    const processedKeys = new Set<string>()
    const results = await Promise.all([processPipelineJob(job, { processedKeys }), processPipelineJob(job, { processedKeys })])
    expect(results.filter((result) => !result.skipped)).toHaveLength(1)
  })

  it('submits MOSS with a stable key, persists its id, and completes after MOSS is ready', async () => {
    const updates: Array<Record<string, unknown>> = []
    let submitted: Record<string, unknown> | undefined
    const moss = {
      createJob: async (input: Record<string, unknown>) => {
        submitted = input
        return { jobId: 'moss-1', response: { id: 'moss-1', status: 'queued' } }
      },
      getJob: async () => ({ jobId: 'moss-1', status: 'waiting_review', progress: 0.95, error: null, response: { id: 'moss-1', status: 'waiting_review' } }),
    }

    const result = await processPipelineJob({ ...job, payload: {} }, { moss: moss as never, getMossMedia: async () => media, update: async (update) => { updates.push(update) } })
    expect(submitted).toMatchObject({ idempotencyKey: 'upload-1:transcribe', media })
    expect(result.status).toBe('completed')
    expect(result.output.mossJobId).toBe('moss-1')
    expect(updates.some((update) => update.stage === 'transcribe:moss_submit')).toBe(true)
    expect(updates.at(-1)).toMatchObject({ progress: 100, stage: 'transcribe:completed' })
  })

  it('keeps waiting jobs recoverable while MOSS is processing', async () => {
    const updates: Array<Record<string, unknown>> = []
    const moss = {
      createJob: async () => ({ jobId: 'moss-1', response: { id: 'moss-1', status: 'queued' } }),
      getJob: async () => ({ jobId: 'moss-1', status: 'transcribing', progress: 0.5, error: null, response: { id: 'moss-1', status: 'transcribing' } }),
    }

    const result = await processPipelineJob({ ...job, payload: {} }, { moss: moss as never, getMossMedia: async () => media, update: async (update) => { updates.push(update) } })
    expect(result).toMatchObject({ status: 'waiting_dependency', progress: 58, stage: 'transcribe:moss_transcribing' })
    expect(updates.at(-1)).toMatchObject({ status: 'waiting_dependency', progress: 58, stage: 'transcribe:moss_transcribing' })
  })

  it('uses the persisted MOSS id after a retry instead of creating another job', async () => {
    let createCalls = 0
    const moss = {
      createJob: async () => { createCalls += 1; return { jobId: 'unexpected', response: {} } },
      getJob: async () => ({ jobId: 'moss-existing', status: 'waiting_review', progress: 0.95, error: null, response: { id: 'moss-existing', status: 'waiting_review' } }),
    }

    const result = await processPipelineJob({ ...job, payload: { mossJobId: 'moss-existing' } }, { moss: moss as never, getMossMedia: async () => { throw new Error('should not read upload') } })
    expect(result.status).toBe('completed')
    expect(createCalls).toBe(0)
  })

  it('keeps the latest stage update when MOSS is unavailable', async () => {
    const updates: Array<Record<string, unknown>> = []
    const moss = {
      createJob: async () => ({ jobId: 'moss-1', response: { id: 'moss-1', status: 'queued' } }),
      getJob: async () => { throw new MossError('MOSS_UNAVAILABLE', 'MOSS service is unavailable', true) },
    }

    await expect(processPipelineJob(job, { moss: moss as never, getMossMedia: async () => media, update: async (update) => { updates.push(update) } })).rejects.toMatchObject({ code: 'MOSS_UNAVAILABLE' })
    expect(updates.at(-1)).toMatchObject({ progress: 20, stage: 'transcribe:moss_accepted' })
  })
})
