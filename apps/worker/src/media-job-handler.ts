import type { PlaybackJob } from './processors/playback'
import type { TranscriptJob } from './processors/transcript'

type JobResult = Record<string, unknown>
type V2FakeJob = { v2JobHandle: string }

export interface MediaJobHandlerOptions {
  processPlayback: (job: PlaybackJob) => Promise<JobResult>
  processTranscript: (job: TranscriptJob) => Promise<JobResult>
  cancelTranscript: (job: TranscriptJob) => Promise<JobResult>
  /**
   * Required by the real worker.  It prevents an event-name mix-up from
   * sending a v2 run into any legacy media/MOSS processor.
   */
  resolvePipelineVersion?: (job: TranscriptJob) => Promise<string | null>
  /** Resolves a queue-safe opaque v2 handle to its private DB job identity. */
  resolveV2Job?: (job: V2FakeJob) => Promise<TranscriptJob | null>
  /** When enabled, reject every legacy event before any legacy resolver runs. */
  v2FakeOnly?: boolean
  /** Test-only F2 state-machine entry points; never fall back to v1. */
  processV2Transcript?: (job: TranscriptJob) => Promise<JobResult>
  cancelV2Transcript?: (job: TranscriptJob) => Promise<JobResult>
}

export interface MediaJobInput {
  name: string
  data: unknown
}

function isTranscriptJob(value: unknown): value is TranscriptJob {
  return typeof value === 'object' && value !== null
    && typeof (value as { mediaAssetId?: unknown }).mediaAssetId === 'string'
    && typeof (value as { processingRunId?: unknown }).processingRunId === 'string'
}

function isV2FakeJob(value: unknown): value is V2FakeJob {
  return typeof value === 'object' && value !== null
    && typeof (value as { v2JobHandle?: unknown }).v2JobHandle === 'string'
    && /^[A-Za-z0-9._:-]{8,128}$/.test((value as { v2JobHandle: string }).v2JobHandle)
}

/**
 * Pure dispatch boundary for the production media worker.
 *
 * F2 permits v2 only through injected test-only state-machine handlers.  The
 * database pipeline fence is checked before any legacy processor is called,
 * so an incorrectly named job cannot reach storage, FFmpeg, MOSS or its
 * cancel adapter. Unknown names likewise never fall through.
 */
export function createMediaJobHandler(options: MediaJobHandlerOptions) {
  return async ({ name, data }: MediaJobInput): Promise<JobResult> => {
    const isV2Event = name === 'media.transcript_process.v2' || name === 'media.transcript_cancel_requested.v2'
    if (isV2Event) {
      if (!isV2FakeJob(data)) return { skipped: true, reason: 'invalid_v2_fake_job_payload' }
      if (!options.resolveV2Job) return { skipped: true, reason: 'v2_fake_runtime_disabled' }
      let resolved: TranscriptJob | null
      try {
        resolved = await options.resolveV2Job(data)
      } catch {
        return { skipped: true, reason: 'v2_handle_resolution_failed' }
      }
      if (!resolved) return { skipped: true, reason: 'v2_job_handle_not_found' }
      if (options.resolvePipelineVersion) {
        let pipelineVersion: string | null
        try {
          pipelineVersion = await options.resolvePipelineVersion(resolved)
        } catch {
          return { skipped: true, reason: 'pipeline_resolution_failed' }
        }
        if (pipelineVersion !== 'g3-transcript-v2') return { skipped: true, reason: 'v2_pipeline_not_available' }
      }
      if (name === 'media.transcript_process.v2') {
        return options.processV2Transcript
          ? options.processV2Transcript(resolved)
          : { skipped: true, reason: 'v2_fake_runtime_disabled' }
      }
      return options.cancelV2Transcript
        ? options.cancelV2Transcript(resolved)
        : { skipped: true, reason: 'v2_fake_runtime_disabled' }
    }

    if (options.v2FakeOnly) return { skipped: true, reason: 'v2_fake_runtime_isolated' }

    if (!isTranscriptJob(data)) return { skipped: true, reason: 'invalid_media_job_payload' }
    let pipelineVersion: string | null = null
    if (options.resolvePipelineVersion) {
      try {
        pipelineVersion = await options.resolvePipelineVersion(data)
      } catch {
        return { skipped: true, reason: 'pipeline_resolution_failed' }
      }
      if (pipelineVersion === 'g3-transcript-v2') {
        return { skipped: true, reason: 'v2_requires_isolated_route' }
      }
    }
    if (name === 'media.upload_verified') return options.processPlayback(data)
    if (name === 'media.transcript_cancel_requested') return options.cancelTranscript(data)
    if (['media.playback_ready', 'moss.callback_received', 'media.transcript_retry_requested', 'media.transcript_process'].includes(name)) {
      return options.processTranscript(data)
    }
    return { skipped: true, reason: 'unsupported_media_job' }
  }
}
