import { Controller, Get, Headers, Inject, Module, Param, Post } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import {
  ActiveTranscriptViewSchema, MAX_UPLOAD_DURATION_MS, TranscriptWordSchema,
  type AuthUser, type MediaAssetView,
} from '@online-learning/contracts'
import { G3_PIPELINE_VERSION_V2, Prisma, arbitrateTranscriptRun } from '@online-learning/database'
import { ApiException } from '../../common/api-exception'
import { CurrentUser } from '../../common/auth.decorators'
import { SERVER_ENV } from '../../config/app-config.module'
import { DatabaseService } from '../../database/database.module'
import { StorageService } from '../../storage/storage.module'

type RevisionedChunk = { chunkIndex: number; planRevision: number }

function currentPlanRevision(run: { activePlanRevision: number; pendingPlanRevision: number | null }) {
  return run.pendingPlanRevision ?? run.activePlanRevision
}

function effectivePlanChunks<T extends RevisionedChunk>(chunks: readonly T[], revision: number): T[] {
  const selected = new Map<number, T>()
  for (const chunk of chunks) {
    if (chunk.planRevision > revision) continue
    const current = selected.get(chunk.chunkIndex)
    if (!current || chunk.planRevision > current.planRevision) selected.set(chunk.chunkIndex, chunk)
  }
  return [...selected.values()].sort((left, right) => left.chunkIndex - right.chunkIndex)
}

function mapEnrollmentNotEligible(reason: string): ApiException {
  switch (reason) {
    case 'asset_not_found':
    case 'deleted':
    case 'owner_mismatch':
      return new ApiException(404, 'not_found', '媒体资产不存在')
    case 'not_playable':
      return new ApiException(409, 'media_not_playable', '媒体尚未准备好播放')
    case 'duration_exceeds_limit':
      return new ApiException(422, 'media_duration_unsupported', '当前仅支持时长不超过 60 分钟的视频')
    case 'active_transcript_exists':
      return new ApiException(409, 'transcript_active_conflict', '已存在可发布字幕，升级需另行处理')
    default:
      return new ApiException(422, 'enrollment_rejected', '当前资产不符合 v2 字幕处理条件')
  }
}

function toView(asset: {
  id: string
  uploadSessionId: string | null
  title: string
  originalName: string
  status: string
  durationMs: number | null
  processingRuns?: Array<{
    pipelineVersion: string
    status: string
    stage: string
    errorCode: string | null
    updatedAt: Date
    activePlanRevision: number
    pendingPlanRevision: number | null
    chunks: Array<{ chunkIndex: number; planRevision: number; status: string }>
    handoffs?: Array<{ logicalHandoffIndex: number; planRevision: number; status: string }>
    transcriptVersions?: Array<{
      hTotal: number; hUnique: number; hR1: number; hUnresolved: number; hSegment: number; hAlignment: number
    }>
  }>
  createdAt: Date
  updatedAt: Date
}): MediaAssetView {
  const playbackRun = asset.processingRuns?.find((run) => run.pipelineVersion === 'g2-playback-v1')
  const transcriptRun = asset.processingRuns?.find((run) => run.pipelineVersion === 'g3-transcript-v1')
    ?? asset.processingRuns?.find((run) => run.pipelineVersion === 'g3-transcript-v2')
  const transcriptChunks = transcriptRun
    ? effectivePlanChunks(transcriptRun.chunks, currentPlanRevision(transcriptRun))
    : []
  const isV2 = transcriptRun?.pipelineVersion === 'g3-transcript-v2'
  return {
    id: asset.id,
    uploadSessionId: asset.uploadSessionId,
    title: asset.title,
    originalName: asset.originalName,
    status: asset.status.toLowerCase() as MediaAssetView['status'],
    durationMs: asset.durationMs,
    processingStage: playbackRun?.stage.toLowerCase() as MediaAssetView['processingStage'] ?? null,
    errorCode: playbackRun?.errorCode ?? null,
    transcriptProcessing: transcriptRun ? {
      status: transcriptRun.status.toLowerCase() as NonNullable<MediaAssetView['transcriptProcessing']>['status'],
      stage: transcriptRun.stage.toLowerCase() as NonNullable<MediaAssetView['transcriptProcessing']>['stage'],
      completedChunks: transcriptChunks.filter((chunk) => chunk.status === 'SUCCEEDED').length,
      totalChunks: transcriptChunks.length,
      errorCode: transcriptRun.errorCode,
      updatedAt: transcriptRun.updatedAt.toISOString(),
      ...(isV2 ? { handoffCounts: handoffCountsView(transcriptRun) } : {}),
    } : undefined,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  }
}

function handoffCountsView(run: {
  activePlanRevision: number
  pendingPlanRevision: number | null
  handoffs?: Array<{ logicalHandoffIndex: number; planRevision: number; status: string }>
  transcriptVersions?: Array<{
    hTotal: number; hUnique: number; hR1: number; hUnresolved: number; hSegment: number; hAlignment: number
  }>
}) {
  const revision = currentPlanRevision(run)
  const handoffs = (run.handoffs ?? []).filter((handoff) => handoff.planRevision === revision)
  const latest = run.transcriptVersions?.[0]
  return {
    total: handoffs.length,
    evidenced: handoffs.filter((handoff) => handoff.status === 'EVIDENCED').length,
    hTotal: latest?.hTotal ?? 0,
    hUnique: latest?.hUnique ?? 0,
    hR1: latest?.hR1 ?? 0,
    hUnresolved: latest?.hUnresolved ?? 0,
    hSegment: latest?.hSegment ?? 0,
    hAlignment: latest?.hAlignment ?? 0,
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
      where: { pipelineVersion: { in: ['g2-playback-v1', 'g3-transcript-v1', 'g3-transcript-v2'] as string[] } },
      orderBy: { createdAt: 'desc' },
      select: {
        pipelineVersion: true, status: true, stage: true, errorCode: true, updatedAt: true,
        activePlanRevision: true, pendingPlanRevision: true,
        chunks: { select: { chunkIndex: true, planRevision: true, status: true } },
        handoffs: { select: { logicalHandoffIndex: true, planRevision: true, status: true } },
        transcriptVersions: { select: { hTotal: true, hUnique: true, hR1: true, hUnresolved: true, hSegment: true, hAlignment: true } },
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
      if (asset.durationMs === null || asset.durationMs > MAX_UPLOAD_DURATION_MS) {
        throw new ApiException(422, 'media_duration_unsupported', '当前仅支持时长不超过 60 分钟的视频')
      }
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
      const planRevision = currentPlanRevision(run)
      const currentChunks = effectivePlanChunks(run.chunks, planRevision)
      const hasChunks = currentChunks.length > 0
      if (hasChunks) {
        const activeInputs = await transaction.mediaObject.findMany({
          where: {
            mediaAssetId, kind: 'AUDIO_CHUNK', deletedAt: null,
            objectKey: { in: currentChunks.map((chunk) => chunk.inputObjectKey) },
          },
          select: { objectKey: true, versionId: true, checksumSha256: true },
        })
        const hasEveryInput = currentChunks.every((chunk) => activeInputs.some((object) => (
          object.objectKey === chunk.inputObjectKey
          && object.versionId === chunk.inputVersionId
          && (chunk.inputChecksum === null || object.checksumSha256 === chunk.inputChecksum)
        )))
        if (!hasEveryInput) {
          throw new ApiException(422, 'moss_rejected', '字幕临时音频已经过期，需要用新流水线版本重新处理')
        }
      }
      await transaction.processingChunk.updateMany({
        where: { id: { in: currentChunks.map((chunk) => chunk.id) }, status: 'FAILED', errorCode: { in: [...retryableCodes] } },
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
        include: { processingRuns: { where: { pipelineVersion: 'g3-transcript-v1' }, take: 1, include: { chunks: true } } },
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
        const currentChunks = effectivePlanChunks(run.chunks, currentPlanRevision(run))
        await transaction.processingRun.update({
          where: { id: run.id }, data: {
            status: 'CANCELLED', errorCode: 'processing_cancelled',
            completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null,
          },
        })
        await transaction.processingChunk.updateMany({
          where: { id: { in: currentChunks.map((chunk) => chunk.id) }, status: { in: ['QUEUED', 'PROCESSING', 'VALIDATING'] } },
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

  @Post(':mediaAssetId/transcript/enroll-v2')
  async enrollTranscriptV2(
    @CurrentUser() user: AuthUser,
    @Param('mediaAssetId') mediaAssetId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey)) {
      throw new ApiException(400, 'invalid_request', '需要有效的 Idempotency-Key')
    }
    if (!this.env.V2_TRANSCRIPT_ALLOWLIST.includes(user.id)) {
      throw new ApiException(403, 'enrollment_not_allowlisted', '当前账号未获准使用 v2 字幕处理')
    }
    return this.database.$transaction(async (transaction) => {
      const outcome = await arbitrateTranscriptRun(transaction, {
        mediaAssetId,
        pipelineVersion: G3_PIPELINE_VERSION_V2,
        startStage: 'PLAYBACK_READY',
        eventType: 'media.transcript_process.v2',
        idempotencyKey: `transcript-enroll-v2:${user.id}:${mediaAssetId}:${idempotencyKey}`,
        ownerId: user.id,
        requireNoActiveTranscript: true,
        maxDurationMs: MAX_UPLOAD_DURATION_MS,
        requestKey: idempotencyKey,
      })
      switch (outcome.kind) {
        case 'created':
          return { enrolled: true, processingRunId: outcome.processingRunId, pipelineVersion: G3_PIPELINE_VERSION_V2, duplicate: false }
        case 'idempotent':
          return { enrolled: true, processingRunId: outcome.processingRunId, pipelineVersion: G3_PIPELINE_VERSION_V2, duplicate: true }
        case 'conflict':
          throw new ApiException(409, 'transcript_pipeline_conflict', '另一条字幕流水线正持有该媒体')
        case 'not_eligible':
          throw mapEnrollmentNotEligible(outcome.reason)
      }
    }, { maxWait: 5_000, timeout: 15_000 })
  }
}

@Module({ controllers: [MediaAssetsController] })
export class MediaAssetsModule {}
