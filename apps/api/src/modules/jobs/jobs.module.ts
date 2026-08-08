import { BadRequestException, Controller, Get, Inject, Injectable, Module, NotFoundException, OnModuleDestroy, Param, Post, UseGuards } from '@nestjs/common'
import { Queue } from 'bullmq'
import type { ProcessingJob } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth/auth.module'

export const MEDIA_QUEUE = 'MEDIA_QUEUE'

const jobTypes = { transcode: 'TRANSCODE', transcribe: 'TRANSCRIBE', translate: 'TRANSLATE', segment: 'SEGMENT', publish: 'PUBLISH' } as const
const jobStatuses = { QUEUED: 'queued', PROCESSING: 'processing', WAITING_DEPENDENCY: 'waiting_dependency', REVIEW: 'review', COMPLETED: 'completed', FAILED: 'failed' } as const

function toContract(job: { id: string; uploadId: string; type: keyof typeof jobTypes | string; status: keyof typeof jobStatuses | string; progress: number; stage?: string | null; error: string | null; errorCode?: string | null; attempts?: number; lastAttemptAt?: Date | null; failedAt?: Date | null; payload?: unknown; updatedAt: Date }): ProcessingJob {
  const payload = typeof job.payload === 'object' && job.payload !== null && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : undefined
  return { id: job.id, uploadId: job.uploadId, type: job.type.toLowerCase() as ProcessingJob['type'], status: jobStatuses[job.status as keyof typeof jobStatuses] ?? job.status.toLowerCase() as ProcessingJob['status'], progress: job.progress, stage: job.stage ?? null, error: job.error, errorCode: job.errorCode ?? null, attempts: job.attempts, lastAttemptAt: job.lastAttemptAt?.toISOString() ?? null, failedAt: job.failedAt?.toISOString() ?? null, payload, updatedAt: job.updatedAt.toISOString() }
}

@Injectable()
export class JobsService implements OnModuleDestroy {
  // Test-only fallback; production and development use ProcessingJob plus BullMQ.
  private readonly testJobs = new Map<string, ProcessingJob>()

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(MEDIA_QUEUE) private readonly queue: Queue<ProcessingJob> | null) {}

  async create(uploadId: string, type: ProcessingJob['type'] = 'transcode', enqueue = true) {
    if (process.env.NODE_ENV === 'test') {
      const existing = [...this.testJobs.values()].find((job) => job.uploadId === uploadId && job.type === type)
      if (existing) return existing
      const job: ProcessingJob = { id: crypto.randomUUID(), uploadId, type, status: 'queued', progress: 0, error: null, updatedAt: new Date().toISOString() }
      this.testJobs.set(job.id, job)
      return job
    }

    const persisted = await this.database.processingJob.upsert({
      where: { uploadId_type: { uploadId, type: jobTypes[type] } },
      update: {},
      create: { id: crypto.randomUUID(), uploadId, type: jobTypes[type], payload: {} },
    })
    const job = toContract(persisted)
    if (enqueue) await this.enqueue(job)
    return job
  }

  async enqueue(job: ProcessingJob) {
    if (!this.queue) return job
    const existing = await this.queue.getJob(job.id)
    if (existing) {
      const state = await existing.getState()
      if (state === 'waiting' || state === 'active' || state === 'delayed') return job
      await existing.remove()
    }
    await this.queue.add(job.type, job, { jobId: job.id, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 })
    return job
  }

  async retry(id: string, userId: string) {
    if (process.env.NODE_ENV === 'test') {
      const job = this.testJobs.get(id)
      if (!job) throw new NotFoundException('任务不存在')
      if (job.status !== 'failed') throw new BadRequestException('只有失败任务可以重试')
      const retried: ProcessingJob = { ...job, status: 'queued', stage: 'retry_requested', error: null, errorCode: null, failedAt: null, updatedAt: new Date().toISOString() }
      this.testJobs.set(id, retried)
      return retried
    }

    const existing = await this.database.processingJob.findUnique({ where: { id }, include: { upload: { select: { userId: true } } } })
    if (!existing || existing.upload.userId !== userId) throw new NotFoundException('任务不存在')
    if (existing.status !== 'FAILED') throw new BadRequestException('只有失败任务可以重试')
    const updated = await this.database.processingJob.updateMany({ where: { id, status: 'FAILED', upload: { userId } }, data: { status: 'QUEUED', stage: 'retry_requested', error: null, errorCode: null, failedAt: null } })
    if (!updated.count) throw new BadRequestException('任务状态已发生变化，请刷新后重试')
    const retried = await this.database.processingJob.findUnique({ where: { id } })
    if (!retried) throw new NotFoundException('任务不存在')
    const contract = toContract(retried)
    await this.enqueue(contract)
    return contract
  }

  async getByUpload(uploadId: string) {
    if (process.env.NODE_ENV === 'test') return [...this.testJobs.values()].find((job) => job.uploadId === uploadId) ?? null
    const job = await this.database.processingJob.findUnique({ where: { uploadId_type: { uploadId, type: 'TRANSCODE' } } })
    return job ? toContract(job) : null
  }

  async list(userId: string) {
    if (process.env.NODE_ENV === 'test') return [...this.testJobs.values()]
    const jobs = await this.database.processingJob.findMany({ where: { upload: { userId } }, orderBy: { updatedAt: 'desc' }, take: 100 })
    return jobs.map(toContract)
  }

  async get(id: string, userId: string) {
    if (process.env.NODE_ENV === 'test') {
      const job = this.testJobs.get(id)
      if (!job) throw new NotFoundException('任务不存在')
      return job
    }
    const job = await this.database.processingJob.findUnique({ where: { id }, include: { upload: { select: { userId: true } } } })
    if (!job || job.upload.userId !== userId) throw new NotFoundException('任务不存在')
    return toContract(job)
  }

  async onModuleDestroy() {
    await this.queue?.close()
  }
}

const mediaQueueProvider = {
  provide: MEDIA_QUEUE,
  useFactory: () => process.env.NODE_ENV === 'test' ? null : new Queue<ProcessingJob>(loadServerEnv().MEDIA_QUEUE_NAME, { connection: { url: loadServerEnv().REDIS_URL } }),
}

@Controller('jobs')
@UseGuards(AuthGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.jobs.list(user.id) }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.jobs.get(id, user.id) }
  @Post(':id/retry') retry(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) { return this.jobs.retry(id, user.id) }
}

@Module({ controllers: [JobsController], providers: [JobsService, mediaQueueProvider], exports: [JobsService] })
export class JobsModule {}
