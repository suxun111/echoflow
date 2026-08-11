import { BadRequestException, Controller, Get, Inject, Injectable, Module, NotFoundException, OnModuleDestroy, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common'
import { Queue } from 'bullmq'
import { loadServerEnv } from '@online-learning/config'
import type { ProcessingJob, TranslationCoverage, TranslateCourseResponse } from '@online-learning/contracts'
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { stage: 'queued', warnings: [] as string[], translatedCount: 0, totalCount: 0 }
  const record = payload as Record<string, unknown>
  return {
    stage: typeof record.stage === 'string' ? record.stage : 'queued',
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
    translatedCount: typeof record.translatedCount === 'number' && Number.isInteger(record.translatedCount) ? Math.max(0, record.translatedCount) : 0,
    totalCount: typeof record.totalCount === 'number' && Number.isInteger(record.totalCount) ? Math.max(0, record.totalCount) : 0,
  }
}

export function toTranslationCoverage(totalCount: number, translatedCount: number, warnings: string[], status?: string): TranslationCoverage {
  const total = Math.max(0, totalCount)
  const translated = Math.min(total, Math.max(0, translatedCount))
  let coverageStatus: TranslationCoverage['status'] = 'not_started'
  if (status === 'PROCESSING' || status === 'QUEUED') coverageStatus = 'processing'
  else if (status === 'FAILED') coverageStatus = 'failed'
  else if (total > 0 && translated === total) coverageStatus = 'completed'
  else if (translated > 0) coverageStatus = 'partial'
  else if (warnings.length) coverageStatus = 'unavailable'
  return { translatedCount: translated, totalCount: total, missingCount: Math.max(0, total - translated), status: coverageStatus, warnings }
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
    error: job.error,
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

  private async enqueue(jobId: string, name: string) {
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
      await this.enqueue(job.id, 'transcribe-local-mp4')
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

    const job = await this.prisma.processingJob.update({
      where: { id: latest.id },
      data: { status: 'QUEUED', progress: 0, error: null, attempts: { increment: 1 }, payload: { stage: 'queued', warnings: [] } },
    })
    await this.prisma.videoAsset.updateMany({ where: { uploads: { some: { id: uploadId } } }, data: { status: 'PROCESSING' } })
    try {
      await this.enqueue(job.id, 'transcribe-local-mp4')
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接 Redis 队列'
      await this.prisma.processingJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: `队列投递失败：${message}`, payload: { stage: 'queue-failed', warnings: [] } } })
      await this.prisma.videoAsset.updateMany({ where: { uploads: { some: { id: uploadId } } }, data: { status: 'FAILED' } })
      throw new ServiceUnavailableException(`Redis 队列不可用：${message}`)
    }
    return toProcessingJob(job)
  }

  async createTranslationForCourse(assetId: string, userId: string): Promise<TranslateCourseResponse> {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { id: assetId, uploads: { some: { userId, private: true } } },
      include: {
        lesson: { include: { cues: { select: { chinese: true } } } },
        uploads: { where: { userId, private: true }, select: { id: true } },
      },
    })
    if (!asset) throw new NotFoundException('私有课程不存在或无权操作')
    if (!asset.lesson) throw new BadRequestException('课程还没有可补译的字幕')
    const totalCount = asset.lesson.cues.length
    const translatedCount = asset.lesson.cues.filter((cue) => cue.chinese.trim()).length
    const uploadIds = asset.uploads.map((upload) => upload.id)
    const active = await this.prisma.processingJob.findFirst({
      where: { uploadId: { in: uploadIds }, type: 'TRANSLATE', status: { in: ['QUEUED', 'PROCESSING'] } },
      orderBy: { updatedAt: 'desc' },
    })
    if (active) {
      const mapped = toProcessingJob(active)
      return { job: mapped, coverage: toTranslationCoverage(totalCount, mapped.translatedCount, mapped.warnings, active.status), queued: true }
    }
    if (!totalCount || translatedCount === totalCount) {
      return { job: null, coverage: toTranslationCoverage(totalCount, translatedCount, [], 'COMPLETED'), queued: false }
    }
    const uploadId = uploadIds[0]
    if (!uploadId) throw new BadRequestException('课程缺少可用的上传记录')
    const job = await this.prisma.processingJob.create({
      data: {
        uploadId,
        type: 'TRANSLATE',
        status: 'QUEUED',
        progress: 0,
        payload: { stage: 'translation-queued', warnings: [], translatedCount, totalCount },
      },
    })
    try {
      await this.enqueue(job.id, 'translate-subtitles')
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接 Redis 队列'
      await this.prisma.processingJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: `队列投递失败：${message}`, payload: { stage: 'queue-failed', warnings: [], translatedCount, totalCount } } })
      throw new ServiceUnavailableException(`Redis 队列不可用：${message}`)
    }
    const mapped = toProcessingJob(job)
    return { job: mapped, coverage: toTranslationCoverage(totalCount, translatedCount, [], 'QUEUED'), queued: true }
  }

  async getOwned(id: string, userId: string) {
    const job = await this.prisma.processingJob.findFirst({ where: { id, upload: { userId } } })
    if (!job) throw new NotFoundException('任务不存在')
    return toProcessingJob(job)
  }

  async onModuleDestroy() {
    await this.queue?.close()
  }
}

@Controller('me/jobs')
@UseGuards(DevIdentityGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get(':id') get(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.jobs.getOwned(id, user.id) }
}

@Module({ imports: [InfrastructureModule], controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
