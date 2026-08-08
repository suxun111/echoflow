import type { ProcessingJob } from '@online-learning/contracts'
import { MossError, type MossClient, type MossMediaInput } from '../moss/client'

export type PipelineContext = {
  processedKeys?: Set<string>
  isProcessed?: (idempotencyKey: string) => Promise<boolean>
  moss?: MossClient
  getMossMedia?: (job: ProcessingJob) => Promise<MossMediaInput>
  update?: (update: {
    status: ProcessingJob['status']
    progress: number
    stage?: string | null
    error: string | null
    errorCode?: string | null
    output?: Record<string, unknown>
  }) => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
}

export type PipelineResult = ProcessingJob & { output: Record<string, unknown>; skipped?: boolean }

const stageOutput: Record<ProcessingJob['type'], Record<string, unknown>> = {
  transcode: { renditions: ['720p', '1080p'] },
  transcribe: { language: 'en', cueCount: 32 },
  translate: { targetLanguage: 'zh-CN' },
  segment: { segmentation: 'semantic-sentence' },
  publish: { visibility: 'private' },
}

const mossSuccessStates = new Set(['waiting_review', 'done'])
const mossFailureStates = new Set(['failed', 'cancelled'])

function normalizedMossStage(status: string) {
  return status.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'unknown'
}

function mossProgress(startingProgress: number, progress: number | null) {
  if (progress === null) return Math.max(startingProgress, 20)
  return Math.max(startingProgress, Math.min(99, Math.round(20 + Math.max(0, Math.min(1, progress)) * 75)))
}

export async function processPipelineJob(job: ProcessingJob, context: PipelineContext): Promise<PipelineResult> {
  const idempotencyKey = `${job.uploadId}:${job.type}`
  if (context.processedKeys?.has(idempotencyKey)) return { ...job, status: job.type === 'publish' ? 'review' : 'completed', progress: 100, output: stageOutput[job.type], skipped: true }
  if (context.processedKeys) context.processedKeys.add(idempotencyKey)
  else if (await context.isProcessed?.(idempotencyKey)) return { ...job, status: job.type === 'publish' ? 'review' : 'completed', progress: 100, output: stageOutput[job.type], skipped: true }

  try {
    const startingProgress = Math.max(0, Math.min(99, job.progress))
    await context.update?.({ status: 'processing', progress: startingProgress, stage: `${job.type}:starting`, error: null, errorCode: null })

    let output = { ...stageOutput[job.type] }
    const existingMossJobId = typeof job.payload?.mossJobId === 'string' ? job.payload.mossJobId : undefined
    if (context.moss) {
      let mossJobId = existingMossJobId
      let media: MossMediaInput | undefined
      const prepareMedia = async () => {
        media ??= await context.getMossMedia?.(job)
        if (!media) throw new Error('MOSS media source is not configured')
        output = { ...output, mossMediaName: media.fileName }
        return media
      }
      const submit = async () => {
        const input = await prepareMedia()
        await context.update?.({ status: 'processing', progress: Math.max(startingProgress, 10), stage: `${job.type}:moss_submit`, error: null, errorCode: null, output })
        const created = await context.moss!.createJob({
          idempotencyKey,
          jobId: job.id,
          uploadId: job.uploadId,
          type: job.type,
          payload: job.payload ?? {},
          media: input,
        })
        mossJobId = created.jobId
        output = { ...output, mossJobId }
        await context.update?.({ status: 'processing', progress: Math.max(startingProgress, 20), stage: `${job.type}:moss_accepted`, error: null, errorCode: null, output })
      }

      if (!mossJobId) await submit()
      else output = { ...output, mossJobId }

      let mossJob
      try {
        mossJob = await context.moss.getJob(mossJobId!)
      } catch (error) {
        // MOSS persists jobs in its runs volume. If that volume was replaced
        // and the saved external id is gone, clear just the external mapping
        // before submitting the original upload again on this same attempt.
        if (error instanceof MossError && error.statusCode === 404) {
          output = { ...output, mossJobId: null }
          await context.update?.({ status: 'processing', progress: Math.max(startingProgress, 10), stage: `${job.type}:moss_job_missing`, error: null, errorCode: null, output })
          mossJobId = undefined
          await submit()
          mossJob = await context.moss.getJob(mossJobId!)
        } else {
          throw error
        }
      }

      const stage = normalizedMossStage(mossJob.status)
      output = { ...output, mossJobId: mossJob.jobId, mossStatus: mossJob.status }
      if (mossFailureStates.has(mossJob.status)) {
        throw new MossError('MOSS_JOB_FAILED', mossJob.error ? `MOSS job failed: ${mossJob.error}` : 'MOSS job failed', false)
      }
      if (!mossSuccessStates.has(mossJob.status)) {
        const progress = mossProgress(startingProgress, mossJob.progress)
        await context.update?.({ status: 'waiting_dependency', progress, stage: `${job.type}:moss_${stage}`, error: null, errorCode: null, output })
        context.processedKeys?.delete(idempotencyKey)
        return { ...job, status: 'waiting_dependency', progress, updatedAt: new Date().toISOString(), stage: `${job.type}:moss_${stage}`, output }
      }
    }

    await (context.delay?.(30) ?? Promise.resolve())
    const result = { ...job, status: job.type === 'publish' ? 'review' as const : 'completed' as const, progress: 100, updatedAt: new Date().toISOString(), stage: `${job.type}:completed`, output }
    await context.update?.({ status: result.status, progress: result.progress, stage: result.stage, error: null, errorCode: null, output: result.output })
    return result
  } catch (error) {
    context.processedKeys?.delete(idempotencyKey)
    throw error
  }
}
