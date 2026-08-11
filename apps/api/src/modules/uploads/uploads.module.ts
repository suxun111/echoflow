import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, Post, UseGuards } from '@nestjs/common'
import { loadServerEnv } from '@online-learning/config'
import { PrivateCourseSummarySchema, UploadCompletionSchema, UploadRequestSchema, UploadTargetSchema, type PrivateCourseSummary, type TranslationCoverage, type UploadRequest } from '@online-learning/contracts'
import type { StorageProvider } from '@online-learning/storage'
import { basename, extname } from 'node:path'
import { CurrentDevUser, DevIdentityGuard, type DevUser } from '../auth/auth.module'
import { STORAGE_PROVIDER, PrismaService } from '../infrastructure/infrastructure.module'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { JobsModule, JobsService, toTranslationCoverage } from '../jobs/jobs.module'

function cleanFileName(fileName: string) {
  return basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-video.mp4'
}

function normalizeContentType(contentType: string | undefined) {
  return contentType?.split(';')[0]?.trim().toLowerCase()
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  private async ensureUser(user: DevUser) {
    await this.prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, phone: user.phone, displayName: user.displayName, role: 'LEARNER' },
      update: { phone: user.phone, displayName: user.displayName },
    })
  }

  async createPresign(user: DevUser, input: UploadRequest) {
    if (normalizeContentType(input.contentType) !== 'video/mp4' || extname(input.fileName).toLowerCase() !== '.mp4') {
      throw new BadRequestException('当前仅支持 MP4 视频')
    }
    await this.ensureUser(user)
    const fileName = cleanFileName(input.fileName)
    const target = await this.storage.createUploadTarget(fileName, input.contentType)
    const asset = await this.prisma.videoAsset.create({
      data: {
        sourcePlatform: 'DIRECT_UPLOAD',
        title: input.title,
        creator: user.displayName,
        coverUrl: '',
        storageKey: target.objectKey,
        durationMs: 0,
        category: input.category,
        accent: input.accent,
        level: input.level,
        status: 'CANDIDATE',
        rightsNote: '开发者本地私有 MP4 上传，已确认学习与处理授权',
      },
    })
    const upload = await this.prisma.upload.create({
      data: {
        userId: user.id,
        videoAssetId: asset.id,
        originalName: fileName,
        storageKey: target.objectKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        rightsConfirmed: true,
        private: true,
      },
    })
    return UploadTargetSchema.parse({ uploadId: upload.id, assetId: asset.id, storageKey: target.objectKey, putUrl: target.uploadUrl, expiresAt: target.expiresAt })
  }

  async complete(user: DevUser, uploadId: string) {
    const upload = await this.prisma.upload.findFirst({ where: { id: uploadId, userId: user.id } })
    if (!upload) throw new NotFoundException('上传记录不存在')
    let object: { size: number; contentType?: string }
    try {
      object = await this.storage.stat(upload.storageKey)
    } catch {
      throw new BadRequestException('上传对象尚未写入 MinIO，请完成浏览器上传后重试')
    }
    if (object.size !== upload.sizeBytes) throw new BadRequestException(`对象大小校验失败：期望 ${upload.sizeBytes}，实际 ${object.size}`)
    const actualType = normalizeContentType(object.contentType)
    if (actualType && actualType !== normalizeContentType(upload.contentType)) throw new BadRequestException(`对象类型校验失败：期望 ${upload.contentType}，实际 ${actualType}`)

    if (!upload.completedAt) await this.prisma.upload.update({ where: { id: upload.id }, data: { completedAt: new Date() } })
    const job = await this.jobs.createForUpload(upload.id, user.id)
    return UploadCompletionSchema.parse({ uploadId: upload.id, job })
  }

  private courseStatus(status: string): PrivateCourseSummary['status'] {
    if (status === 'READY' || status === 'PUBLISHED') return 'ready'
    if (status === 'FAILED' || status === 'REJECTED') return 'failed'
    return 'processing'
  }

  async listCourses(user: DevUser) {
    const assets = await this.prisma.videoAsset.findMany({
      where: { uploads: { some: { userId: user.id, private: true } } },
      include: { lesson: { include: { cues: { select: { chinese: true } } } } },
      orderBy: { updatedAt: 'desc' },
    })
    return Promise.all(assets.map(async (asset) => PrivateCourseSummarySchema.parse({
      id: asset.id,
      title: asset.title,
      creator: asset.creator,
      coverUrl: asset.coverStorageKey ? await this.storage.createReadUrl(asset.coverStorageKey) : null,
      durationSeconds: Math.round(asset.durationMs / 1000),
      status: this.courseStatus(asset.status),
      cueCount: asset.lesson?.cues.length ?? 0,
      chineseCueCount: asset.lesson?.cues.filter((cue) => cue.chinese.trim().length > 0).length ?? 0,
      updatedAt: asset.updatedAt.toISOString(),
    })))
  }

  async getCourse(user: DevUser, assetId: string) {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { id: assetId, uploads: { some: { userId: user.id, private: true } } },
      include: { lesson: { include: { cues: { orderBy: { order: 'asc' } } } }, uploads: { where: { userId: user.id }, include: { jobs: { orderBy: { updatedAt: 'desc' }, take: 1 } } } },
    })
    if (!asset || !asset.storageKey) throw new NotFoundException('私有课程不存在')
    if (!asset.lesson || asset.status !== 'READY') throw new BadRequestException('课程尚未处理完成')
    const latestJob = asset.uploads[0]?.jobs[0]
    const latestTranslationJob = await this.prisma.processingJob.findFirst({
      where: { type: 'TRANSLATE', upload: { videoAssetId: asset.id, userId: user.id } },
      orderBy: { updatedAt: 'desc' },
    })
    const payload = (latestTranslationJob?.payload ?? latestJob?.payload)
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    const warningPayload = payloadRecord.warnings
    const warnings = Array.isArray(warningPayload) ? warningPayload.filter((warning): warning is string => typeof warning === 'string') : []
    const payloadTotal = typeof payloadRecord.totalCount === 'number' ? payloadRecord.totalCount : asset.lesson.cues.length
    const payloadTranslated = typeof payloadRecord.translatedCount === 'number' ? payloadRecord.translatedCount : asset.lesson.cues.filter((cue) => cue.chinese.trim()).length
    const translation: TranslationCoverage = toTranslationCoverage(payloadTotal, payloadTranslated, warnings, latestTranslationJob?.status)
    return {
      id: asset.id,
      title: asset.title,
      creator: asset.creator,
      coverUrl: asset.coverStorageKey ? await this.storage.createReadUrl(asset.coverStorageKey) : null,
      playbackUrl: await this.storage.createReadUrl(asset.storageKey),
      durationSeconds: Math.round(asset.durationMs / 1000),
      cues: asset.lesson.cues.map((cue) => ({ id: cue.id, order: cue.order, startMs: cue.startMs, endMs: cue.endMs, english: cue.english, chinese: cue.chinese, speaker: cue.speaker, keywords: Array.isArray(cue.keywords) ? cue.keywords.filter((word): word is string => typeof word === 'string') : [], reviewed: cue.reviewed })),
      warnings,
      translation,
    }
  }
}

@Controller('uploads')
@UseGuards(DevIdentityGuard)
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService, @Inject(JobsService) private readonly jobs: JobsService) {}

  @Post('presign') async presign(@Body() input: unknown, @CurrentDevUser() user: DevUser) { return this.uploads.createPresign(user, UploadRequestSchema.parse(input)) }
  @Post(':id/complete') async complete(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.uploads.complete(user, id) }
  @Post(':id/retry') async retry(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.jobs.retry(id, user.id) }
}

@Controller('me/courses')
@UseGuards(DevIdentityGuard)
export class PrivateCoursesController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService, @Inject(JobsService) private readonly jobs: JobsService) {}

  @Get() list(@CurrentDevUser() user: DevUser) { return this.uploads.listCourses(user) }
  @Get(':id') get(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.uploads.getCourse(user, id) }
  @Post(':id/translate') translate(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.jobs.createTranslationForCourse(id, user.id) }
}

@Module({ imports: [InfrastructureModule, JobsModule], controllers: [UploadsController, PrivateCoursesController], providers: [UploadsService] })
export class UploadsModule {}
