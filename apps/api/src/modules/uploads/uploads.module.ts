import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, Post, UseGuards } from '@nestjs/common'
import { loadServerEnv } from '@online-learning/config'
import { PrivateCourseSummarySchema, TranslateCourseResponseSchema, UploadCompletionSchema, UploadRequestSchema, UploadTargetSchema, type PrivateCourseSummary, type UploadRequest } from '@online-learning/contracts'
import type { StorageProvider } from '@online-learning/storage'
import { basename, extname } from 'node:path'
import { CurrentDevUser, DevIdentityGuard, type DevUser } from '../auth/auth.module'
import { STORAGE_PROVIDER, PrismaService } from '../infrastructure/infrastructure.module'
import { InfrastructureModule } from '../infrastructure/infrastructure.module'
import { JobsModule, JobsService } from '../jobs/jobs.module'

function cleanFileName(fileName: string) {
  return basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-video.mp4'
}

function normalizeContentType(contentType: string | undefined) {
  return contentType?.split(';')[0]?.trim().toLowerCase()
}

function readJobPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { stage: 'queued', warnings: [] as string[], translatedCount: 0, totalCount: 0, vocabularyTranslatedCount: 0, vocabularyTotalCount: 0 }
  const record = payload as Record<string, unknown>
  return {
    stage: typeof record.stage === 'string' ? record.stage : 'queued',
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
    translatedCount: typeof record.translatedCount === 'number' && Number.isFinite(record.translatedCount) ? record.translatedCount : 0,
    totalCount: typeof record.totalCount === 'number' && Number.isFinite(record.totalCount) ? record.totalCount : 0,
    vocabularyTranslatedCount: typeof record.vocabularyTranslatedCount === 'number' && Number.isFinite(record.vocabularyTranslatedCount) ? record.vocabularyTranslatedCount : 0,
    vocabularyTotalCount: typeof record.vocabularyTotalCount === 'number' && Number.isFinite(record.vocabularyTotalCount) ? record.vocabularyTotalCount : 0,
  }
}

function coverageStatus(translatedCount: number, totalCount: number, jobStatus?: string, warnings: string[] = []) {
  if (jobStatus === 'QUEUED' || jobStatus === 'PROCESSING') return 'processing' as const
  if (totalCount === 0) return 'not_started' as const
  if (translatedCount === totalCount) return 'completed' as const
  if (translatedCount > 0) return 'partial' as const
  return warnings.length ? 'unavailable' as const : 'not_started' as const
}

function makeCoverage(translatedCount: number, totalCount: number, jobStatus?: string, warnings: string[] = []) {
  return {
    translatedCount,
    totalCount,
    missingCount: Math.max(0, totalCount - translatedCount),
    status: coverageStatus(translatedCount, totalCount, jobStatus, warnings),
    warnings,
  }
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
      include: { lesson: { include: { cues: { select: { chinese: true } }, vocabularyTerms: { select: { translation: true, translationStatus: true } } } } },
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
       vocabularyCount: asset.lesson?.vocabularyTerms.length ?? 0,
       translatedVocabularyCount: asset.lesson?.vocabularyTerms.filter((term) => term.translation.trim() && term.translationStatus === 'TRANSLATED').length ?? 0,
       updatedAt: asset.updatedAt.toISOString(),
    })))
  }

  async getCourse(user: DevUser, assetId: string) {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { id: assetId, uploads: { some: { userId: user.id, private: true } } },
      include: { lesson: { include: { cues: { orderBy: { order: 'asc' } }, vocabularyTerms: { orderBy: { id: 'asc' } } } }, uploads: { where: { userId: user.id }, include: { jobs: { orderBy: { updatedAt: 'desc' }, take: 1 } } } },
    })
    if (!asset || !asset.storageKey) throw new NotFoundException('私有课程不存在')
    if (!asset.lesson || asset.status !== 'READY') throw new BadRequestException('课程尚未处理完成')
    const latestJob = asset.uploads[0]?.jobs[0]
    const jobPayload = readJobPayload(latestJob?.payload)
    const vocabularyWarnings = asset.lesson.vocabularyTerms
      .filter((term) => term.translationStatus === 'RETRYABLE_FAILED' || term.translationStatus === 'PERMANENT_FAILED')
      .map((term) => `${term.translationErrorCode ?? 'TRANSLATION_FAILED'}: 课程词汇“${term.word}”尚未获得中文释义`)
    const warnings = [...jobPayload.warnings, ...vocabularyWarnings.filter((warning) => !jobPayload.warnings.includes(warning))]
    const translatedCount = asset.lesson.cues.filter((cue) => cue.chinese.trim()).length
    const vocabularyTranslatedCount = asset.lesson.vocabularyTerms.filter((term) => term.translation.trim() && term.translationStatus === 'TRANSLATED').length
    const translation = makeCoverage(translatedCount, asset.lesson.cues.length, latestJob?.status, warnings)
    const vocabularyTranslation = makeCoverage(vocabularyTranslatedCount, asset.lesson.vocabularyTerms.length, latestJob?.type === 'TRANSLATE' ? latestJob.status : undefined, warnings)
    return {
      id: asset.id,
      title: asset.title,
      creator: asset.creator,
      coverUrl: asset.coverStorageKey ? await this.storage.createReadUrl(asset.coverStorageKey) : null,
      playbackUrl: await this.storage.createReadUrl(asset.storageKey),
      durationSeconds: Math.round(asset.durationMs / 1000),
      cues: asset.lesson.cues.map((cue) => ({ id: cue.id, order: cue.order, startMs: cue.startMs, endMs: cue.endMs, english: cue.english, chinese: cue.chinese, speaker: cue.speaker, keywords: Array.isArray(cue.keywords) ? cue.keywords.filter((word): word is string => typeof word === 'string') : [], reviewed: cue.reviewed })),
      vocabulary: asset.lesson.vocabularyTerms.map((term) => ({ id: term.id, lessonId: term.lessonId, sourceCueId: term.cueId, word: term.word, normalizedWord: term.normalizedWord, termType: term.termType, sourceSentence: term.sourceSentence, translation: term.translation, translationSource: term.translationSource, translationStatus: term.translationStatus, translationErrorCode: term.translationErrorCode, translatedAt: term.translatedAt?.toISOString() ?? null })),
      warnings,
      translation,
      vocabularyTranslation,
    }
  }

  async translateCourse(user: DevUser, assetId: string) {
    const job = await this.jobs.createTranslationForCourse(assetId, user.id)
    const course = await this.getCourse(user, assetId)
    return TranslateCourseResponseSchema.parse({ job, coverage: course.translation, vocabularyCoverage: course.vocabularyTranslation, queued: job.status === 'queued' })
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
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Get() list(@CurrentDevUser() user: DevUser) { return this.uploads.listCourses(user) }
  @Get(':id') get(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.uploads.getCourse(user, id) }
  @Post(':id/translate') translate(@Param('id') id: string, @CurrentDevUser() user: DevUser) { return this.uploads.translateCourse(user, id) }
}

@Module({ imports: [InfrastructureModule, JobsModule], controllers: [UploadsController, PrivateCoursesController], providers: [UploadsService] })
export class UploadsModule {}
