import { randomUUID } from 'node:crypto'
import type { MossAdapter, MossJob, MossResult, MossSubmitInput } from './adapter'

export class FakeMossAdapter implements MossAdapter {
  private readonly jobs = new Map<string, MossJob>()
  private readonly byKey = new Map<string, string>()
  private readonly results = new Map<string, MossResult>()

  submissions = 0

  async submit(input: MossSubmitInput) {
    const existingId = this.byKey.get(input.idempotencyKey)
    if (existingId) {
      const existing = this.jobs.get(existingId)!
      if (!['failed', 'cancelled'].includes(existing.status)) return existing
      const retried = { ...existing, status: 'queued' as const, errorCode: null }
      this.jobs.set(existingId, retried)
      this.results.delete(existingId)
      this.submissions += 1
      return retried
    }
    const externalJobId = `fake-${randomUUID()}`
    const job: MossJob = { externalJobId, idempotencyKey: input.idempotencyKey, status: 'queued', errorCode: null }
    this.jobs.set(externalJobId, job)
    this.byKey.set(input.idempotencyKey, externalJobId)
    this.submissions += 1
    return job
  }

  async query(externalJobId: string) {
    const job = this.jobs.get(externalJobId)
    if (!job) throw new Error('fake_moss_job_missing')
    return { ...job }
  }

  async result(externalJobId: string) {
    const result = this.results.get(externalJobId)
    if (!result) throw new Error('fake_moss_result_missing')
    return structuredClone(result)
  }

  async cancel(externalJobId: string) {
    const job = await this.query(externalJobId)
    this.jobs.set(externalJobId, { ...job, status: 'cancelled' })
  }

  succeed(externalJobId: string, result: MossResult) {
    const job = this.jobs.get(externalJobId)
    if (!job) throw new Error('fake_moss_job_missing')
    this.results.set(externalJobId, structuredClone(result))
    this.jobs.set(externalJobId, { ...job, status: 'succeeded' })
  }

  fail(externalJobId: string, errorCode = 'fake_failure') {
    const job = this.jobs.get(externalJobId)
    if (!job) throw new Error('fake_moss_job_missing')
    this.jobs.set(externalJobId, { ...job, status: 'failed', errorCode })
  }
}
