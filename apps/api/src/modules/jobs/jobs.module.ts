import { BadRequestException, Controller, Get, Inject, Injectable, Module, NotFoundException, OnModuleDestroy, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common'
import { Queue } from 'bullmq'
import { loadServerEnv } from '@online-learning/config'
import type { ProcessingJob } from '@online-learning/contracts'
import { CurrentDevUser, DevIdentityGuard, type DevUser } from '../auth/auth.module'
import { PrismaService } from '../infrastructure/infrastructure.module'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'

const queueName = 'online-learning-media'

type DbJob = {
  id: string
  uploadId: string
  type: string
  status: string
  progress: number
  error: string | null
  payload: unknown
  updatedAt: Date
}

function getPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { stage: 'queued', warnings: [] as string[], translatedCount: 0, totalCount: 0, vocabularyTranslatedCount: 0, vocabularyTotalCount: 0, errorCode: null as string | null }
  const record = payload as Record<string, unknown>
  return {
    stage: typeof record.stage === 'string' ? record.stage : 'queued',
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
    translatedCount: typeof record.translatedCount === 'number' && Number.isFinite(record.translatedCount) ? record.translatedCount : 0,
    totalCount: typeof record.totalCount === 'number' && Number.isFinite(record.totalCount) ? record.totalCount : 0,
    vocabularyTranslatedCount: typeof record.vocabularyTranslatedCount === 'number' && Number.isFinite(record.vocabularyTranslatedCount) ? record.vocabularyTranslatedCount : 0,
    vocabularyTotalCount: typeof record.vocabularyTotalCount === 'number' && Number.isFinite(record.vocabularyTotalCount) ? record.vocabularyTotalCount : 0,
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : null,
  }
}

function getMossJobs(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const value = (payload as Record<string, unknown>).mossJobs
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, jobId]) => typeof jobId === 'string' && jobId.length > 0))
}

export function toProcessingJob(job: DbJob): ProcessingJob {
  const payload = getPayload(job.payload)
  return {
    id: job.id,
    uploadId: job.uploadId,
    type: job.type.toLowerCase() as ProcessingJob['type'],
    status: job.status.toLowerCase() as ProcessingJob['status'],
    progress: job.progress,
    stage: payload.stage,
    warnings: payload.warnings,
    translatedCount: payload.translatedCount,
    totalCount: payload.totalCount,
    vocabularyTranslatedCount: payload.vocabularyTranslatedCount,
    vocabularyTotalCount: payload.vocabularyTotalCount,
    error: job.error,
    errorCode: payload.errorCode,
    updatedAt: job.updatedAt.toISOString(),
  }
}

@Injectable()
export class JobsService implements OnModuleDestroy {
  private queue?: Queue

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private getQueue() {
    if (!this.queue) this.queue = new Queue(queueName, { connection: { url: loadServerEnv().REDIS_URL } })
    return this.queue
  }

  private async enqueue(jobId: string, name = 'transcribe-local-mp4') {
    const queue = this.getQueue()
    await queue.remove(jobId).catch(() => undefined)
    await queue.add(name, { jobId }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    })
  }

  async createTranslationForCourse(assetId: string, userId: string) {
    const upload = await this.prisma.upload.findFirst({
      where: { videoAssetId: assetId, userId, private: true },
      include: { videoAsset: { include: { lesson: true } } },
    })
    if (!upload || !upload.videoAsset?.lesson) throw new NotFoundException('私有课程尚未准备好字幕')
    if (upload.videoAsset.status !== 'READY') throw new BadRequestException('课程尚未处理完成')

    const inFlight = await this.prisma.processingJob.findFirst({
      where: { uploadId: upload.id, type: 'TRANSLATE', status: { in: ['QUEUED', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (inFlight) return toProcessingJob(inFlight)

    const job = await this.prisma.processingJob.create({
      data: {
        uploadId: upload.id,
        type: 'TRANSLATE',
        status: 'QUEUED',
        progress: 0,
        payload: { stage: 'translation-queued', warnings: [], translatedCount: 0, totalCount: 0, vocabularyTranslatedCount: 0, vocabularyTotalCount: 0 },
      },
    })
    try {
      await this.enqueue(job.id, 'translate-course-vocabulary')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Redis 队列不可用'
      await this.prisma.processingJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: `队列投递失败：${message}`, payload: { stage: 'queue-failed', warnings: [message] } } })
      throw new ServiceUnavailableException(`Redis 队列不可用：${message}`)
    }
    return toProcessingJob(job)
  }

  async createForUpload(uploadId: string, userId: string) {
    const upload = await this.prisma.upload.findFirst({ where: { id: uploadId, userId }, select: { id: true, videoAssetId: true, completedAt: true } })
    if (!upload) throw new NotFoundException('上传记录不存在')
    if (!upload.completedAt) throw new NotFoundException('上传文件尚未完成')

    const inFlight = await this.prisma.processingJob.findFirst({
      where: { uploadId, type: 'TRANSCRIBE', status: { in: ['QUEUED', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (inFlight) return toProcessingJob(inFlight)

    const job = await this.prisma.processingJob.create({
      data: { uploadId, type: 'TRANSCRIBE', status: 'QUEUED', progress: 0, payload: { stage: 'queued', warnings: [] } },
    })
    if (upload.videoAssetId) await this.prisma.videoAsset.update({ where: { id: upload.videoAssetId }, data: { status: 'PROCESSING' } })

    try {
      await this.enqueue(job.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接 Redis 队列'
      await this.prisma.processingJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: `队列投递失败：${message}`, payload: { stage: 'queue-failed', warnings: [] } } })
      if (upload.videoAssetId) await this.prisma.videoAsset.update({ where: { id: upload.videoAssetId }, data: { status: 'FAILED' } })
      throw new ServiceUnavailableException(`Redis 队列不可用：${message}`)
    }
    return toProcessingJob(job)
  }

  async retry(uploadId: string, userId: string) {
    const latest = await this.prisma.processingJob.findFirst({
      where: { uploadId, upload: { userId }, type: 'TRANSCRIBE' },
      orderBy: { updatedAt: 'desc' },
    })
    if (!latest) throw new NotFoundException('没有可重试的任务')
    if (latest.status === 'QUEUED' || latest.status === 'PROCESSING') return toProcessingJob(latest)

    const mossJobs = getMossJobs(latest.payload)

    const job = await this.prisma.processingJob.update({
      where: { id: latest.id },
      data: {
        status: 'QUEUED',
        progress: 0,
        error: null,
        attempts: { increment: 1 },
        payload: { stage: 'queued', warnings: [], ...(Object.keys(mossJobs).length ? { mossJobs } : {}) },
      },
    })
    await this.prisma.videoAsset.updateMany({ where: { uploads: { some: { id: uploadId } } }, data: { status: 'PROCESSING' } })
    try {
      await this.enqueue(job.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接 Redis 队列'
      await this.prisma.processingJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: `队列投递失败：${message}`, payload: { stage: 'queue-failed', warnings: [] } } })
      await this.prisma.videoAsset.updateMany({ where: { uploads: { some: { id: uploadId } } }, data: { status: 'FAILED' } })
      throw new ServiceUnavailableException(`Redis 队列不可用：${message}`)
    }
    return toProcessingJob(job)
  }

  async getOwned(id: string, userId: string) {
    const job = await this.prisma.processingJob.findFirst({ where: { id, upload: { userId } } })
    if (!job) throw new NotFoundException('任务不存在')
    return toProcessingJob(job)
  }

  async listOwned(userId: string) {
    const jobs = await this.prisma.processingJob.findMany({
      where: { upload: { userId }, type: 'TRANSCRIBE' },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    })
    return jobs.map(toProcessingJob)
  }

  async onModuleDestroy() {
    await this.queue?.close()
  }
}

@Controller('me/jobs')
@UseGuards(DevIdentityGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get() list(@CurrentDevUser() user: DevUser) { return this.jobs.listOwned(user.id) }
  @Get(':id') get(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.jobs.getOwned(id, user.id) }
}

@Module({ imports: [InfrastructureModule], controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
