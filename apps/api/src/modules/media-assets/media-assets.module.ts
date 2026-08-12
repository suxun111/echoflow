import { Controller, Get, Inject, Module, Param, Post } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import type { AuthUser, MediaAssetView } from '@online-learning/contracts'
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
  processingRuns?: Array<{ stage: string; errorCode: string | null }>
  createdAt: Date
  updatedAt: Date
}): MediaAssetView {
  return {
    id: asset.id,
    uploadSessionId: asset.uploadSessionId,
    title: asset.title,
    originalName: asset.originalName,
    status: asset.status.toLowerCase() as MediaAssetView['status'],
    durationMs: asset.durationMs,
    processingStage: asset.processingRuns?.[0]?.stage.toLowerCase() as MediaAssetView['processingStage'] ?? null,
    errorCode: asset.processingRuns?.[0]?.errorCode ?? null,
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

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const items = await this.database.mediaAsset.findMany({
      where: { ownerId: user.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
      include: { processingRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { stage: true, errorCode: true } } },
    })
    return { items: items.map(toView) }
  }

  @Get(':mediaAssetId')
  async get(@CurrentUser() user: AuthUser, @Param('mediaAssetId') mediaAssetId: string) {
    const asset = await this.database.mediaAsset.findFirst({
      where: { id: mediaAssetId, ownerId: user.id, deletedAt: null },
      include: { processingRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { stage: true, errorCode: true } } },
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
}

@Module({ controllers: [MediaAssetsController] })
export class MediaAssetsModule {}
