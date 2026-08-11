import type { ProcessingJob } from '@online-learning/contracts'

export type PipelineContext = { processedKeys: Set<string>; delay?: (milliseconds: number) => Promise<void>; inFlight?: Map<string, Promise<PipelineResult>> }
export type PipelineResult = ProcessingJob & { output: Record<string, unknown>; skipped?: boolean }

const inFlightByProcessedKeys = new WeakMap<Set<string>, Map<string, Promise<PipelineResult>>>()

const stageOutput: Record<ProcessingJob['type'], Record<string, unknown>> = {
  transcode: { renditions: ['720p', '1080p'] },
  transcribe: { language: 'en', cueCount: 32 },
  translate: { targetLanguage: 'zh-CN' },
  segment: { segmentation: 'semantic-sentence' },
  publish: { visibility: 'private' },
}

export async function processPipelineJob(job: ProcessingJob, context: PipelineContext): Promise<PipelineResult> {
  const idempotencyKey = `${job.uploadId}:${job.type}`
  if (context.processedKeys.has(idempotencyKey)) return { ...job, status: 'completed', progress: 100, output: stageOutput[job.type], skipped: true }

  const inFlight = context.inFlight ?? getInFlightMap(context.processedKeys)
  const existing = inFlight.get(idempotencyKey)
  if (existing) return { ...(await existing), skipped: true }

  const task: Promise<PipelineResult> = (async (): Promise<PipelineResult> => {
    await (context.delay?.(30) ?? Promise.resolve())
    context.processedKeys.add(idempotencyKey)
    return { ...job, status: job.type === 'publish' ? 'review' : 'completed', progress: 100, updatedAt: new Date().toISOString(), output: stageOutput[job.type] }
  })()
  inFlight.set(idempotencyKey, task)
  try { return await task } finally { inFlight.delete(idempotencyKey) }
}

function getInFlightMap(processedKeys: Set<string>) {
  const existing = inFlightByProcessedKeys.get(processedKeys)
  if (existing) return existing
  const created = new Map<string, Promise<PipelineResult>>()
  inFlightByProcessedKeys.set(processedKeys, created)
  return created
}
