import { describe, expect, it } from 'vitest'
import { workerLifecycleLogEntry } from './runtime-log'

describe('workerLifecycleLogEntry', () => {
  it('never places an opaque v2 enrollment handle in a lifecycle log', () => {
    const opaqueHandle = 'g3-v2-enroll:opaque-owner-media-idempotency-handle'

    const completed = workerLifecycleLogEntry({
      outcome: 'completed', route: 'v2_fake', eventType: 'media.transcript_process.v2', jobId: `transcript-v2-${opaqueHandle}`,
    })
    const failed = workerLifecycleLogEntry({
      outcome: 'failed', route: 'v2_fake', eventType: 'media.transcript_process.v2', jobId: `transcript-v2-${opaqueHandle}`,
    })

    expect(completed).toEqual({ type: 'media_job_completed', route: 'v2_fake', eventType: 'media.transcript_process.v2' })
    expect(failed).toEqual({ type: 'media_job_failed', route: 'v2_fake', eventType: 'media.transcript_process.v2', code: 'worker_job_failed' })
    expect(JSON.stringify(completed)).not.toContain(opaqueHandle)
    expect(JSON.stringify(failed)).not.toContain(opaqueHandle)
  })
})
