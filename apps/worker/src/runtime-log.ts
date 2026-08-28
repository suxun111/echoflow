/**
 * Stable, non-content lifecycle log envelopes for the media worker.
 *
 * The isolated F2 route must not reveal BullMQ job IDs because its generated
 * job ID embeds an opaque enrollment handle.  Legacy logs retain their
 * existing diagnostic identifier; this helper makes the split explicit and
 * unit-testable without importing the side-effecting worker entry point.
 */
export function workerLifecycleLogEntry(input: {
  outcome: 'completed' | 'failed'
  route: 'v2_fake' | 'legacy'
  eventType?: string
  jobId?: string | number | null
}): Record<string, string | number | undefined> {
  const type = input.outcome === 'completed' ? 'media_job_completed' : 'media_job_failed'
  if (input.route === 'v2_fake') {
    return input.outcome === 'completed'
      ? { type, route: 'v2_fake', eventType: input.eventType ?? 'unknown' }
      : { type, route: 'v2_fake', eventType: input.eventType ?? 'unknown', code: 'worker_job_failed' }
  }
  return input.outcome === 'completed'
    ? { type, jobId: input.jobId ?? undefined }
    : { type, jobId: input.jobId ?? undefined, code: 'worker_job_failed' }
}
