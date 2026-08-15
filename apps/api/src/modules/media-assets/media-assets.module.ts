import { Controller, Get, Headers, Inject, Module, Param, Post } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { ActiveTranscriptViewSchema, TranscriptWordSchema, type AuthUser, type MediaAssetView } from '@online-learning/contracts'
import { Prisma } from '@online-learning/database'
import { ApiException } from '../../common/api-exception'
import { CurrentUser } from '../../common/auth.decorators'
import { SERVER_ENV } from '../../config/app-config.module'
import { DatabaseService } from '../../database/database.module'
import { StorageService } from '../../storage/storage.module'

function toView(asset: {
  id: string
  uploadSessionId: string | null
  title: string
  originalName: string
  status: string
  durationMs: number | null
  processingRuns?: Array<{
    status: string
    stage: string
    errorCode: string | null
    updatedAt: Date
    chunks: Array<{ status: string }>
  }>
  createdAt: Date
  updatedAt: Date
}): MediaAssetView {
  const run = asset.processingRuns?.[0]
  return {
    id: asset.id,
    uploadSessionId: asset.uploadSessionId,
    title: asset.title,
    originalName: asset.originalName,
    status: asset.status.toLowerCase() as MediaAssetView['status'],
    durationMs: asset.durationMs,
    processingStage: run?.stage.toLowerCase() as MediaAssetView['processingStage'] ?? null,
    errorCode: run?.errorCode ?? null,
    transcriptProcessing: run ? {
      status: run.status.toLowerCase() as NonNullable<MediaAssetView['transcriptProcessing']>['status'],
      stage: run.stage.toLowerCase() as NonNullable<MediaAssetView['transcriptProcessing']>['stage'],
      completedChunks: run.chunks.filter((chunk) => chunk.status === 'SUCCEEDED').length,
      totalChunks: run.chunks.length,
      errorCode: run.errorCode,
      updatedAt: run.updatedAt.toISOString(),
    } : undefined,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  }
}

@Controller('media-assets')
export class MediaAssetsController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  private processingInclude() {
    return {
      where: { pipelineVersion: 'g3-transcript-v1' },
      orderBy: { createdAt: 'desc' }, take: 1,
      select: {
        status: true, stage: true, errorCode: true, updatedAt: true,
        chunks: { select: { status: true } },
      },
    } as const
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const items = await this.database.mediaAsset.findMany({
      where: { ownerId: user.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
      include: { processingRuns: this.processingInclude() },
    })
    return { items: items.map(toView) }
  }

  @Get(':mediaAssetId')
  async get(@CurrentUser() user: AuthUser, @Param('mediaAssetId') mediaAssetId: string) {
    const asset = await this.database.mediaAsset.findFirst({
      where: { id: mediaAssetId, ownerId: user.id, deletedAt: null },
      include: { processingRuns: this.processingInclude() },
    })
    if (!asset) throw new ApiException(404, 'not_found', '媒体资产不存在')
    return toView(asset)
  }

  @Post(':mediaAssetId/playback-url')
  async playback(@CurrentUser() user: AuthUser, @Param('mediaAssetId') mediaAssetId: string) {
    const asset = await this.database.mediaAsset.findFirst({
      where: { id: mediaAssetId, ownerId: user.id, deletedAt: null },
      include: { objects: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } } },
    })
    if (!asset) throw new ApiException(404, 'not_found', '媒体资产不存在')
    if (asset.status !== 'PLAYABLE') throw new ApiException(409, 'media_not_playable', '媒体尚未准备好播放')
    const object = asset.objects.find((candidate) => candidate.kind === 'PLAYBACK')
      ?? asset.objects.find((candidate) => candidate.kind === 'ORIGINAL')
    if (!object) throw new ApiException(409, 'media_not_playable', '可播放对象不存在')
    try {
      const playbackUrl = await this.storage.createReadUrl(
        object.objectKey, this.env.STORAGE_SIGNED_URL_TTL_SECONDS, object.versionId,
      )
      return {
        mediaAssetId: asset.id,
        playbackUrl,
        expiresAt: new Date(Date.now() + this.env.STORAGE_SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      }
    } catch {
      throw new ApiException(503, 'storage_unavailable', '暂时无法签发播放地址')
    }
  }

  @Get(':mediaAssetId/transcript')
  async transcript(@CurrentUser() user: AuthUser, @Param('mediaAssetId') mediaAssetId: string) {
    const asset = await this.database.mediaAsset.findFirst({ where: { id: mediaAssetId, ownerId: user.id, deletedAt: null }, select: { id: true } })
    if (!asset) throw new ApiException(404, 'not_found', '媒体资产不存在')
    const transcript = await this.database.transcriptVersion.findFirst({
      where: { mediaAssetId, status: 'ACTIVE' },
      include: { cues: { orderBy: { order: 'asc' } } },
    })
    if (!transcript || !transcript.publishedAt) throw new ApiException(409, 'transcript_not_ready', '完整英文字幕尚未准备好')
    return ActiveTranscriptViewSchema.parse({
      id: transcript.id, mediaAssetId: transcript.mediaAssetId, version: transcript.version,
      language: transcript.language, durationMs: transcript.durationMs, cueCount: transcript.cueCount,
      pipelineVersion: transcript.pipelineVersion, modelVersion: transcript.modelVersion,
      publishedAt: transcript.publishedAt.toISOString(),
      cues: transcript.cues.map((cue) => ({
        id: cue.id, order: cue.order, startMs: cue.startMs, endMs: cue.endMs,
        text: cue.text, words: TranscriptWordSchema.array().parse(cue.words),
      })),
    })
  }

  @Post(':mediaAssetId/transcript/retry')
  async retryTranscript(
    @CurrentUser() user: AuthUser,
    @Param('mediaAssetId') mediaAssetId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey)) {
      throw new ApiException(400, 'invalid_request', '需要有效的 Idempotency-Key')
    }
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${mediaAssetId}, 0))`
      const asset = await transaction.mediaAsset.findFirst({
        where: { id: mediaAssetId, ownerId: user.id, deletedAt: null },
        include: { processingRuns: { where: { pipelineVersion: 'g3-transcript-v1' }, take: 1, include: { chunks: true } } },
      })
      if (!asset) throw new ApiException(404, 'not_found', '媒体资产不存在')
      if (asset.status !== 'PLAYABLE') throw new ApiException(409, 'media_not_playable', '媒体尚未准备好播放')
      const run = asset.processingRuns[0]
      if (!run) throw new ApiException(409, 'transcript_not_ready', '字幕任务尚未创建')
      const eventKey = `transcript-retry:${user.id}:${mediaAssetId}:${idempotencyKey}`
      if (await transaction.outboxEvent.findUnique({ where: { idempotencyKey: eventKey } })) {
        return { accepted: true, processingRunId: run.id, duplicate: true }
      }
      if (['QUEUED', 'PROCESSING', 'VALIDATING'].includes(run.status)) {
        throw new ApiException(409, 'transcript_active_conflict', '字幕任务仍在处理中')
      }
      if (run.status === 'SUCCEEDED') throw new ApiException(409, 'transcript_active_conflict', '完整字幕已经发布')
      const retryableCodes = new Set(['audio_extract_failed', 'moss_unavailable', 'moss_timeout', 'moss_rate_limited', 'transcript_publish_failed'])
      if (!run.errorCode || !retryableCodes.has(run.errorCode)) {
        throw new ApiException(422, 'moss_rejected', '该失败需要修正输入或 MOSS 配置后以新流水线版本处理')
      }
      const hasChunks = run.chunks.length > 0
      if (hasChunks) {
        const activeInputs = await transaction.mediaObject.count({
          where: {
            mediaAssetId, kind: 'AUDIO_CHUNK', deletedAt: null,
            metadata: { path: ['processingRunId'], equals: run.id },
          },
        })
        if (activeInputs !== run.chunks.length) {
          throw new ApiException(422, 'moss_rejected', '字幕临时音频已经过期，需要用新流水线版本重新处理')
        }
      }
      await transaction.processingChunk.updateMany({
        where: { processingRunId: run.id, status: 'FAILED', errorCode: { in: [...retryableCodes] } },
        data: {
          status: 'QUEUED', attempt: 0, failedAt: null, nextPollAt: new Date(),
          errorCode: null, errorDetail: Prisma.DbNull, externalJobId: null,
          externalUpdatedAt: null, externalCancelledAt: null, submittedAt: null, completedAt: null,
        },
      })
      await transaction.processingRun.update({
        where: { id: run.id }, data: {
          status: 'QUEUED', stage: hasChunks ? 'TRANSCRIBING' : 'PLAYBACK_READY', attempt: 0,
          failedAt: null, completedAt: null, errorCode: null, errorDetail: Prisma.DbNull,
          leaseOwner: null, leaseExpiresAt: null,
        },
      })
      await transaction.outboxEvent.create({ data: {
        aggregateType: 'ProcessingRun', aggregateId: run.id, eventType: 'media.transcript_retry_requested',
        idempotencyKey: eventKey, payload: { mediaAssetId, processingRunId: run.id },
      } })
      return { accepted: true, processingRunId: run.id, duplicate: false }
    }, { maxWait: 5_000, timeout: 15_000 })
  }

  @Post(':mediaAssetId/transcript/cancel')
  async cancelTranscript(
    @CurrentUser() user: AuthUser,
    @Param('mediaAssetId') mediaAssetId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey)) {
      throw new ApiException(400, 'invalid_request', '需要有效的 Idempotency-Key')
    }
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${mediaAssetId}, 0))`
      const asset = await transaction.mediaAsset.findFirst({
        where: { id: mediaAssetId, ownerId: user.id, deletedAt: null },
        include: { processingRuns: { where: { pipelineVersion: 'g3-transcript-v1' }, take: 1 } },
      })
      if (!asset) throw new ApiException(404, 'not_found', '媒体资产不存在')
      const run = asset.processingRuns[0]
      if (!run) throw new ApiException(409, 'transcript_not_ready', '字幕任务尚未创建')
      const eventKey = `transcript-cancel:${user.id}:${mediaAssetId}:${idempotencyKey}`
      if (await transaction.outboxEvent.findUnique({ where: { idempotencyKey: eventKey } })) {
        return { cancelled: true, processingRunId: run.id, duplicate: true }
      }
      if (run.status === 'SUCCEEDED') throw new ApiException(409, 'transcript_active_conflict', '已发布的字幕任务不能取消')
      if (run.status !== 'CANCELLED') {
        await transaction.processingRun.update({
          where: { id: run.id }, data: {
            status: 'CANCELLED', errorCode: 'processing_cancelled',
            completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null,
          },
        })
        await transaction.processingChunk.updateMany({
          where: { processingRunId: run.id, status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] } },
          data: {
            status: 'CANCELLED', errorCode: 'processing_cancelled', completedAt: new Date(),
            nextPollAt: null, leaseOwner: null, leaseExpiresAt: null,
          },
        })
      }
      await transaction.outboxEvent.create({ data: {
        aggregateType: 'ProcessingRun', aggregateId: run.id, eventType: 'media.transcript_cancel_requested',
        idempotencyKey: eventKey, payload: { mediaAssetId, processingRunId: run.id },
      } })
      return { cancelled: true, processingRunId: run.id, duplicate: false }
    }, { maxWait: 5_000, timeout: 15_000 })
  }
}

@Module({ controllers: [MediaAssetsController] })
export class MediaAssetsModule {}
