import { describe, expect, it, vi } from 'vitest'
import { createMediaJobHandler } from './media-job-handler'

const job = { mediaAssetId: 'asset-synthetic', processingRunId: 'run-synthetic' }
const v2Job = { v2JobHandle: 'g3-v2-enroll:synthetic-safe-handle-0001' }

describe('createMediaJobHandler', () => {
  it('routes v2 only to injected Fake handlers after a database pipeline fence', async () => {
    const processPlayback = vi.fn(async () => ({ completed: true }))
    const processTranscript = vi.fn(async () => ({ completed: true }))
    const cancelTranscript = vi.fn(async () => ({ cancelled: 1 }))
    const processV2Transcript = vi.fn(async () => ({ fake: 'advanced' }))
    const cancelV2Transcript = vi.fn(async () => ({ fake: 'cancelled' }))
    const handler = createMediaJobHandler({
      processPlayback, processTranscript, cancelTranscript,
      resolvePipelineVersion: vi.fn(async () => 'g3-transcript-v2'),
      resolveV2Job: vi.fn(async () => job),
      processV2Transcript, cancelV2Transcript,
    })

    await expect(handler({ name: 'media.transcript_process.v2', data: v2Job })).resolves.toEqual({ fake: 'advanced' })
    await expect(handler({ name: 'media.transcript_cancel_requested.v2', data: v2Job })).resolves.toEqual({ fake: 'cancelled' })
    await expect(handler({ name: 'media.playback_ready', data: job })).resolves.toEqual({ skipped: true, reason: 'v2_requires_isolated_route' })
    await expect(handler({ name: 'media.upload_verified', data: job })).resolves.toEqual({ skipped: true, reason: 'v2_requires_isolated_route' })
    expect(processPlayback).not.toHaveBeenCalled()
    expect(processTranscript).not.toHaveBeenCalled()
    expect(cancelTranscript).not.toHaveBeenCalled()
    expect(processV2Transcript).toHaveBeenCalledTimes(1)
    expect(cancelV2Transcript).toHaveBeenCalledTimes(1)
  })

  it('rejects a v2 event whose run is not v2 instead of guessing a processor', async () => {
    const processPlayback = vi.fn(async () => ({ completed: true }))
    const processTranscript = vi.fn(async () => ({ completed: true }))
    const cancelTranscript = vi.fn(async () => ({ cancelled: 1 }))
    const handler = createMediaJobHandler({
      processPlayback, processTranscript, cancelTranscript,
      resolvePipelineVersion: vi.fn(async () => 'g3-transcript-v1'),
      resolveV2Job: vi.fn(async () => job),
      processV2Transcript: vi.fn(async () => ({ fake: true })),
    })

    await expect(handler({ name: 'media.transcript_process.v2', data: v2Job })).resolves.toEqual({
      skipped: true, reason: 'v2_pipeline_not_available',
    })
    expect(processPlayback).not.toHaveBeenCalled()
    expect(processTranscript).not.toHaveBeenCalled()
    expect(cancelTranscript).not.toHaveBeenCalled()
  })

  it('routes established v1 job names and never falls through for unknown names', async () => {
    const processPlayback = vi.fn(async () => ({ playback: true }))
    const processTranscript = vi.fn(async () => ({ transcript: true }))
    const cancelTranscript = vi.fn(async () => ({ cancelled: true }))
    const handler = createMediaJobHandler({ processPlayback, processTranscript, cancelTranscript })

    await expect(handler({ name: 'media.upload_verified', data: job })).resolves.toEqual({ playback: true })
    await expect(handler({ name: 'media.playback_ready', data: job })).resolves.toEqual({ transcript: true })
    await expect(handler({ name: 'moss.callback_received', data: job })).resolves.toEqual({ transcript: true })
    await expect(handler({ name: 'media.transcript_cancel_requested', data: job })).resolves.toEqual({ cancelled: true })
    await expect(handler({ name: 'untrusted.event', data: job })).resolves.toEqual({ skipped: true, reason: 'unsupported_media_job' })
    expect(processPlayback).toHaveBeenCalledTimes(1)
    expect(processTranscript).toHaveBeenCalledTimes(2)
    expect(cancelTranscript).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid payload without invoking a processor', async () => {
    const processPlayback = vi.fn(async () => ({ playback: true }))
    const processTranscript = vi.fn(async () => ({ transcript: true }))
    const cancelTranscript = vi.fn(async () => ({ cancelled: true }))
    const handler = createMediaJobHandler({ processPlayback, processTranscript, cancelTranscript })

    await expect(handler({ name: 'media.upload_verified', data: {} })).resolves.toEqual({ skipped: true, reason: 'invalid_media_job_payload' })
    expect(processPlayback).not.toHaveBeenCalled()
    expect(processTranscript).not.toHaveBeenCalled()
    expect(cancelTranscript).not.toHaveBeenCalled()
  })

  it('does not accept legacy identifiers in a canonical v2 event', async () => {
    const processPlayback = vi.fn(async () => ({ playback: true }))
    const processTranscript = vi.fn(async () => ({ transcript: true }))
    const cancelTranscript = vi.fn(async () => ({ cancelled: true }))
    const handler = createMediaJobHandler({ processPlayback, processTranscript, cancelTranscript })

    await expect(handler({ name: 'media.transcript_process.v2', data: job })).resolves.toEqual({
      skipped: true, reason: 'invalid_v2_fake_job_payload',
    })
    expect(processPlayback).not.toHaveBeenCalled()
    expect(processTranscript).not.toHaveBeenCalled()
    expect(cancelTranscript).not.toHaveBeenCalled()
  })

  it('isolates a v2 Fake worker from every legacy event name', async () => {
    const processPlayback = vi.fn(async () => ({ playback: true }))
    const processTranscript = vi.fn(async () => ({ transcript: true }))
    const cancelTranscript = vi.fn(async () => ({ cancelled: true }))
    const handler = createMediaJobHandler({
      processPlayback, processTranscript, cancelTranscript, v2FakeOnly: true,
    })

    await expect(handler({ name: 'media.upload_verified', data: job })).resolves.toEqual({
      skipped: true, reason: 'v2_fake_runtime_isolated',
    })
    await expect(handler({ name: 'media.transcript_cancel_requested', data: job })).resolves.toEqual({
      skipped: true, reason: 'v2_fake_runtime_isolated',
    })
    expect(processPlayback).not.toHaveBeenCalled()
    expect(processTranscript).not.toHaveBeenCalled()
    expect(cancelTranscript).not.toHaveBeenCalled()
  })
})
