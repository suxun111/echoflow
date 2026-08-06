import type { ProcessingJob } from '@online-learning/contracts'

export type PipelineContext = {
  processedKeys?: Set<string>
  isProcessed?: (idempotencyKey: string) => Promise<boolean>
  update?: (update: { status: ProcessingJob['status']; progress: number; error: string | null; output?: Record<string, unknown> }) => Promise<void>
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

export async function processPipelineJob(job: ProcessingJob, context: PipelineContext): Promise<PipelineResult> {
  const idempotencyKey = `${job.uploadId}:${job.type}`
  if (context.processedKeys?.has(idempotencyKey)) return { ...job, status: job.type === 'publish' ? 'review' : 'completed', progress: 100, output: stageOutput[job.type], skipped: true }
  if (context.processedKeys) context.processedKeys.add(idempotencyKey)
  else if (await context.isProcessed?.(idempotencyKey)) return { ...job, status: job.type === 'publish' ? 'review' : 'completed', progress: 100, output: stageOutput[job.type], skipped: true }
  await context.update?.({ status: 'processing', progress: 0, error: null })
  await (context.delay?.(30) ?? Promise.resolve())
  const result = { ...job, status: job.type === 'publish' ? 'review' as const : 'completed' as const, progress: 100, updatedAt: new Date().toISOString(), output: stageOutput[job.type] }
  await context.update?.({ status: result.status, progress: result.progress, error: null, output: result.output })
  return result
}
