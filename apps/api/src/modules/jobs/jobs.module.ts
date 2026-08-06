import { Controller, Get, Inject, Injectable, Module, NotFoundException, OnModuleDestroy, Param, UseGuards } from '@nestjs/common'
import { Queue } from 'bullmq'
import type { ProcessingJob } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth/auth.module'

export const MEDIA_QUEUE = 'MEDIA_QUEUE'

const jobTypes = { transcode: 'TRANSCODE', transcribe: 'TRANSCRIBE', translate: 'TRANSLATE', segment: 'SEGMENT', publish: 'PUBLISH' } as const
const jobStatuses = { QUEUED: 'queued', PROCESSING: 'processing', REVIEW: 'review', COMPLETED: 'completed', FAILED: 'failed' } as const

function toContract(job: { id: string; uploadId: string; type: keyof typeof jobTypes | string; status: keyof typeof jobStatuses | string; progress: number; error: string | null; updatedAt: Date }): ProcessingJob {
  return { id: job.id, uploadId: job.uploadId, type: job.type.toLowerCase() as ProcessingJob['type'], status: jobStatuses[job.status as keyof typeof jobStatuses] ?? job.status.toLowerCase() as ProcessingJob['status'], progress: job.progress, error: job.error, updatedAt: job.updatedAt.toISOString() }
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
    await this.queue.add(job.type, job, { jobId: job.id, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 })
    return job
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
}

@Module({ controllers: [JobsController], providers: [JobsService, mediaQueueProvider], exports: [JobsService] })
export class JobsModule {}
