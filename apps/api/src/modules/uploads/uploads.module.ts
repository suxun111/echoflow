import { Body, Controller, Get, Inject, Injectable, Module, Param, ParseIntPipe, Post } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import {
  CreateUploadSchema, SignUploadPartsSchema, UploadPartSchema,
  type AuthUser, type CreateUpload, type UploadSessionView,
} from '@online-learning/contracts'
import { Prisma, UploadStatus } from '@online-learning/database'
import type { MultipartPart, StoredObject } from '@online-learning/storage'
import { ApiException } from '../../common/api-exception'
import { CurrentUser } from '../../common/auth.decorators'
import { SERVER_ENV } from '../../config/app-config.module'
import { DatabaseService } from '../../database/database.module'
import { StorageService } from '../../storage/storage.module'

const ACTIVE_UPLOAD_STATUSES: UploadStatus[] = [UploadStatus.CREATED, UploadStatus.UPLOADING, UploadStatus.VERIFYING]
const MULTIPART_UPLOAD_STATUSES: UploadStatus[] = [UploadStatus.CREATED, UploadStatus.UPLOADING]

type UploadWithParts = Prisma.UploadSessionGetPayload<{ include: { parts: true; mediaAsset: { select: { id: true } } } }>

function normalizeEtag(etag: string) {
  return etag.trim().replace(/^"|"$/g, '')
}

function isStorageCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.mp4$/i, '').trim().slice(0, 300) || 'Untitled video'
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  private expectedPartCount(upload: { sizeBytes: bigint; partSizeBytes: bigint }) {
    return Number((upload.sizeBytes + upload.partSizeBytes - 1n) / upload.partSizeBytes)
  }

  private expectedPartSize(upload: { sizeBytes: bigint; partSizeBytes: bigint }, partNumber: number) {
    const count = this.expectedPartCount(upload)
    if (partNumber < 1 || partNumber > count) throw new ApiException(422, 'upload_part_invalid', '分片编号超出范围')
    return partNumber === count
      ? Number(upload.sizeBytes - upload.partSizeBytes * BigInt(count - 1))
      : Number(upload.partSizeBytes)
  }

  private toView(upload: UploadWithParts): UploadSessionView {
    const parts = upload.parts.slice().sort((left, right) => left.partNumber - right.partNumber)
    return {
      id: upload.id,
      status: upload.status.toLowerCase() as UploadSessionView['status'],
      originalName: upload.originalName,
      title: upload.title,
      contentType: 'video/mp4',
      sizeBytes: Number(upload.sizeBytes),
      fileFingerprint: upload.fileFingerprint,
      partSizeBytes: Number(upload.partSizeBytes),
      partCount: this.expectedPartCount(upload),
      expiresAt: upload.expiresAt.toISOString(),
      completedAt: upload.completedAt?.toISOString() ?? null,
      uploadedBytes: parts.reduce((sum, part) => sum + Number(part.sizeBytes), 0),
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        sizeBytes: Number(part.sizeBytes),
        etag: part.etag,
        completedAt: part.createdAt.toISOString(),
      })),
      mediaAssetId: upload.mediaAsset?.id ?? null,
    }
  }

  private include() {
    return { parts: true, mediaAsset: { select: { id: true } } } as const
  }

  private async findOwned(uploadId: string, ownerId: string): Promise<UploadWithParts> {
    const upload = await this.database.uploadSession.findFirst({
      where: { id: uploadId, ownerId },
      include: this.include(),
    })
    if (!upload) throw new ApiException(404, 'not_found', '上传任务不存在')
    return upload
  }

  private async expireUpload(upload: UploadWithParts) {
    if (upload.providerUploadId) {
      try {
        await this.storage.abortMultipartUpload(upload.objectKey, upload.providerUploadId)
      } catch (error) {
        if (!isStorageCode(error, 'NoSuchUpload')) throw new ApiException(503, 'storage_unavailable', '暂时无法清理过期上传')
        try {
          await this.storage.remove(upload.objectKey)
        } catch (removeError) {
          if (!isStorageCode(removeError, 'NoSuchKey')) throw new ApiException(503, 'storage_unavailable', '暂时无法清理过期对象')
        }
      }
    }
    await this.database.uploadSession.updateMany({
      where: { id: upload.id, status: { in: ACTIVE_UPLOAD_STATUSES } },
      data: { status: UploadStatus.EXPIRED, abortedAt: new Date() },
    })
  }

  private async ensureActive(upload: UploadWithParts) {
    if (upload.expiresAt.getTime() <= Date.now()) {
      await this.expireUpload(upload)
      throw new ApiException(410, 'upload_expired', '上传任务已过期')
    }
    if (!ACTIVE_UPLOAD_STATUSES.includes(upload.status)) throw new ApiException(409, 'conflict', '上传任务已经结束')
    if (!upload.providerUploadId) throw new ApiException(503, 'storage_unavailable', '对象存储上传尚未准备好')
  }

  private async expireStaleForOwner(ownerId: string) {
    const stale = await this.database.uploadSession.findMany({
      where: { ownerId, status: { in: ACTIVE_UPLOAD_STATUSES }, expiresAt: { lte: new Date() } },
      include: this.include(),
    })
    for (const upload of stale) await this.expireUpload(upload)
  }

  private validateManifest(upload: UploadWithParts, parts: MultipartPart[]) {
    const expectedCount = this.expectedPartCount(upload)
    if (parts.length !== expectedCount) {
      throw new ApiException(409, 'upload_manifest_incomplete', '对象存储中的分片尚未完整', { expectedCount, actualCount: parts.length })
    }
    for (let index = 0; index < expectedCount; index += 1) {
      const part = parts[index]
      const partNumber = index + 1
      if (!part || part.partNumber !== partNumber || part.sizeBytes !== this.expectedPartSize(upload, partNumber)) {
        throw new ApiException(422, 'upload_part_invalid', '对象存储中的分片清单不合法', { partNumber })
      }
    }
  }

  private async upsertProviderParts(
    uploadId: string,
    parts: MultipartPart[],
    transaction: Pick<Prisma.TransactionClient, 'uploadPart'> = this.database,
  ) {
    for (const part of parts) {
      await transaction.uploadPart.upsert({
        where: { uploadSessionId_partNumber: { uploadSessionId: uploadId, partNumber: part.partNumber } },
        create: {
          uploadSessionId: uploadId,
          partNumber: part.partNumber,
          sizeBytes: BigInt(part.sizeBytes),
          etag: normalizeEtag(part.etag),
        },
        update: { sizeBytes: BigInt(part.sizeBytes), etag: normalizeEtag(part.etag) },
      })
    }
  }

  private async synchronizeProviderParts(upload: UploadWithParts, parts: MultipartPart[]) {
    const validParts = parts.filter((part) => part.sizeBytes === this.expectedPartSize(upload, part.partNumber))
    await this.database.$transaction(async (transaction) => {
      await transaction.uploadPart.deleteMany({
        where: {
          uploadSessionId: upload.id,
          ...(validParts.length ? { partNumber: { notIn: validParts.map((part) => part.partNumber) } } : {}),
        },
      })
      await this.upsertProviderParts(upload.id, validParts, transaction)
    })
    return validParts
  }

  async create(owner: AuthUser, input: unknown) {
    const data: CreateUpload = CreateUploadSchema.parse(input)
    if (data.sizeBytes > this.env.UPLOAD_MAX_FILE_BYTES) throw new ApiException(422, 'unprocessable_entity', '文件超过当前上传上限')
    await this.expireStaleForOwner(owner.id)

    const existing = await this.database.uploadSession.findFirst({
      where: { ownerId: owner.id, status: { in: ACTIVE_UPLOAD_STATUSES } },
      include: this.include(),
    })
    if (existing) {
      if (existing.fileFingerprint === data.fileFingerprint && existing.sizeBytes === BigInt(data.sizeBytes)) return this.toView(existing)
      throw new ApiException(409, 'upload_active_conflict', '当前已有一个未完成上传，请先完成或取消')
    }

    const [stored, active] = await Promise.all([
      this.database.mediaObject.aggregate({
        where: { kind: 'ORIGINAL', deletedAt: null, mediaAsset: { ownerId: owner.id, deletedAt: null } },
        _sum: { sizeBytes: true },
      }),
      this.database.uploadSession.aggregate({
        where: { ownerId: owner.id, status: { in: ACTIVE_UPLOAD_STATUSES } },
        _sum: { sizeBytes: true },
      }),
    ])
    const committedBytes = stored._sum.sizeBytes ?? 0n
    const activeBytes = active._sum.sizeBytes ?? 0n
    if (committedBytes + activeBytes + BigInt(data.sizeBytes) > BigInt(this.env.UPLOAD_USER_QUOTA_BYTES)) {
      throw new ApiException(422, 'unprocessable_entity', '该视频会超过当前私人存储配额')
    }

    const id = crypto.randomUUID()
    const objectKey = `owners/${owner.id}/original/${id}.mp4`
    let upload: UploadWithParts
    try {
      upload = await this.database.uploadSession.create({
        data: {
          id,
          ownerId: owner.id,
          originalName: data.fileName,
          title: data.title ?? titleFromFileName(data.fileName),
          contentType: data.contentType,
          sizeBytes: BigInt(data.sizeBytes),
          fileFingerprint: data.fileFingerprint,
          bucket: this.storage.bucket,
          objectKey,
          partSizeBytes: BigInt(this.env.UPLOAD_PART_SIZE_BYTES),
          expiresAt: new Date(Date.now() + this.env.UPLOAD_SESSION_TTL_SECONDS * 1000),
        },
        include: this.include(),
      })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') {
        throw new ApiException(409, 'upload_active_conflict', '当前已有一个未完成上传，请先完成或取消')
      }
      throw error
    }

    let providerUploadId: string | null = null
    try {
      providerUploadId = await this.storage.createMultipartUpload(objectKey, data.contentType)
      upload = await this.database.uploadSession.update({
        where: { id }, data: { providerUploadId }, include: this.include(),
      })
      return this.toView(upload)
    } catch {
      if (providerUploadId) await this.storage.abortMultipartUpload(objectKey, providerUploadId).catch(() => undefined)
      await this.database.uploadSession.updateMany({ where: { id, status: UploadStatus.CREATED }, data: { status: UploadStatus.FAILED } })
      throw new ApiException(503, 'storage_unavailable', '无法创建对象存储上传任务')
    }
  }

  async list(ownerId: string) {
    await this.expireStaleForOwner(ownerId)
    const uploads = await this.database.uploadSession.findMany({
      where: { ownerId }, include: this.include(), orderBy: { createdAt: 'desc' }, take: 50,
    })
    return { items: uploads.map((upload) => this.toView(upload)) }
  }

  async get(ownerId: string, uploadId: string) {
    let upload = await this.findOwned(uploadId, ownerId)
    if (upload.expiresAt.getTime() <= Date.now() && ACTIVE_UPLOAD_STATUSES.includes(upload.status)) {
      await this.expireUpload(upload)
      upload = await this.findOwned(uploadId, ownerId)
    }
    if (upload.providerUploadId && MULTIPART_UPLOAD_STATUSES.includes(upload.status)) {
      try {
        const providerParts = await this.storage.listMultipartParts(upload.objectKey, upload.providerUploadId)
        await this.synchronizeProviderParts(upload, providerParts)
        upload = await this.findOwned(uploadId, ownerId)
      } catch (error) {
        if (!isStorageCode(error, 'NoSuchUpload')) throw new ApiException(503, 'storage_unavailable', '无法读取对象存储分片清单')
        try {
          const object = await this.storage.statObject(upload.objectKey)
          this.assertObject(upload, object)
          return { ...this.toView(upload), status: 'verifying' as const, uploadedBytes: Number(upload.sizeBytes) }
        } catch {
          throw new ApiException(503, 'storage_unavailable', '上传对象尚不可用')
        }
      }
    }
    return this.toView(upload)
  }

  async signParts(ownerId: string, uploadId: string, input: unknown) {
    const data = SignUploadPartsSchema.parse(input)
    const upload = await this.findOwned(uploadId, ownerId)
    await this.ensureActive(upload)
    let providerParts: MultipartPart[]
    try {
      providerParts = await this.storage.listMultipartParts(upload.objectKey, upload.providerUploadId!)
      providerParts = await this.synchronizeProviderParts(upload, providerParts)
    } catch (error) {
      if (isStorageCode(error, 'NoSuchUpload')) throw new ApiException(409, 'conflict', '上传对象已经合并，请重新完成校验')
      throw new ApiException(503, 'storage_unavailable', '无法读取对象存储分片清单')
    }
    const completed = new Set(providerParts.map((part) => part.partNumber))
    const requested = data.partNumbers.filter((partNumber) => {
      this.expectedPartSize(upload, partNumber)
      return !completed.has(partNumber)
    })
    const expiresAt = new Date(Date.now() + this.env.STORAGE_SIGNED_URL_TTL_SECONDS * 1000).toISOString()
    try {
      const parts = await Promise.all(requested.map(async (partNumber) => ({
        partNumber,
        uploadUrl: await this.storage.createPartUploadUrl(
          upload.objectKey, upload.providerUploadId!, partNumber, this.env.STORAGE_SIGNED_URL_TTL_SECONDS,
        ),
        expiresAt,
      })))
      await this.database.uploadSession.updateMany({
        where: { id: upload.id, status: UploadStatus.CREATED }, data: { status: UploadStatus.UPLOADING },
      })
      return { parts }
    } catch {
      throw new ApiException(503, 'storage_unavailable', '无法签发上传地址')
    }
  }

  async recordPart(ownerId: string, uploadId: string, partNumber: number, input: unknown) {
    const data = UploadPartSchema.parse({ ...(input as object), partNumber })
    const upload = await this.findOwned(uploadId, ownerId)
    await this.ensureActive(upload)
    const expectedSize = this.expectedPartSize(upload, partNumber)
    if (data.sizeBytes !== expectedSize) throw new ApiException(422, 'upload_part_invalid', '分片大小与上传合同不一致')
    try {
      const providerParts = await this.storage.listMultipartParts(upload.objectKey, upload.providerUploadId!)
      const providerPart = providerParts.find((part) => part.partNumber === partNumber)
      if (!providerPart || providerPart.sizeBytes !== expectedSize || normalizeEtag(providerPart.etag) !== normalizeEtag(data.etag)) {
        throw new ApiException(422, 'upload_part_invalid', '对象存储未确认该分片')
      }
      await this.upsertProviderParts(upload.id, [providerPart])
      await this.database.uploadSession.updateMany({ where: { id: upload.id, status: UploadStatus.CREATED }, data: { status: UploadStatus.UPLOADING } })
      return { partNumber, sizeBytes: providerPart.sizeBytes, etag: normalizeEtag(providerPart.etag) }
    } catch (error) {
      if (error instanceof ApiException) throw error
      throw new ApiException(503, 'storage_unavailable', '无法确认上传分片')
    }
  }

  private assertObject(upload: UploadWithParts, object: StoredObject) {
    if (object.sizeBytes !== Number(upload.sizeBytes)) {
      throw new ApiException(422, 'upload_object_mismatch', '对象大小与上传合同不一致')
    }
    if (object.contentType && object.contentType !== 'video/mp4' && object.contentType !== 'application/octet-stream') {
      throw new ApiException(422, 'upload_object_mismatch', '对象类型与上传合同不一致')
    }
  }

  async complete(ownerId: string, uploadId: string) {
    const initial = await this.findOwned(uploadId, ownerId)
    if (initial.status !== UploadStatus.COMPLETED) await this.ensureActive(initial)
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${uploadId}))`
      let upload = await transaction.uploadSession.findFirst({
        where: { id: uploadId, ownerId }, include: this.include(),
      })
      if (!upload) throw new ApiException(404, 'not_found', '上传任务不存在')
      if (upload.status === UploadStatus.COMPLETED && upload.mediaAsset) {
        return { upload: this.toView(upload), mediaAssetId: upload.mediaAsset.id }
      }
      await this.ensureActive(upload)

      let providerParts: MultipartPart[] | null = null
      let completed: { etag: string; versionId: string | null } | null = null
      try {
        providerParts = await this.storage.listMultipartParts(upload.objectKey, upload.providerUploadId!)
        this.validateManifest(upload, providerParts)
        await this.upsertProviderParts(upload.id, providerParts, transaction)
        await transaction.uploadSession.update({ where: { id: upload.id }, data: { status: UploadStatus.VERIFYING } })
        completed = await this.storage.completeMultipartUpload(upload.objectKey, upload.providerUploadId!, providerParts)
      } catch (error) {
        if (!isStorageCode(error, 'NoSuchUpload') && !isStorageCode(error, 'NoSuchKey')) {
          if (error instanceof ApiException) throw error
          throw new ApiException(503, 'storage_unavailable', '对象存储无法完成上传')
        }
      }

      if (!providerParts) {
        await transaction.uploadSession.update({ where: { id: upload.id }, data: { status: UploadStatus.VERIFYING } })
      }

      let object: StoredObject
      try {
        object = await this.storage.statObject(upload.objectKey, completed?.versionId)
      } catch {
        throw new ApiException(503, 'storage_unavailable', '上传对象尚不可用')
      }
      this.assertObject(upload, object)

      const assetId = crypto.randomUUID()
      const runId = crypto.randomUUID()
      const asset = await transaction.mediaAsset.create({
        data: {
          id: assetId,
          ownerId,
          uploadSessionId: upload.id,
          title: upload.title,
          originalName: upload.originalName,
          objects: {
            create: {
              kind: 'ORIGINAL',
              bucket: upload.bucket,
              objectKey: upload.objectKey,
              versionId: object.versionId,
              contentType: upload.contentType,
              sizeBytes: upload.sizeBytes,
              etag: normalizeEtag(object.etag),
              metadata: { lastModified: object.lastModified.toISOString() },
            },
          },
        },
      })
      await transaction.processingRun.create({
        data: {
          id: runId,
          ownerId,
          mediaAssetId: asset.id,
          pipelineVersion: 'g2-playback-v1',
          stage: 'UPLOAD_VERIFIED',
        },
      })
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'MediaAsset',
          aggregateId: asset.id,
          eventType: 'media.upload_verified',
          idempotencyKey: `media:${asset.id}:upload_verified:g2-playback-v1`,
          payload: { mediaAssetId: asset.id, processingRunId: runId, attempt: 0 },
        },
      })
      upload = await transaction.uploadSession.update({
        where: { id: upload.id },
        data: { status: UploadStatus.COMPLETED, completedAt: new Date() },
        include: this.include(),
      })
      return { upload: this.toView(upload), mediaAssetId: asset.id }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 60_000 })
  }

  async cancel(ownerId: string, uploadId: string) {
    const upload = await this.findOwned(uploadId, ownerId)
    if (upload.status === UploadStatus.CANCELLED) return { cancelled: true }
    if (ACTIVE_UPLOAD_STATUSES.includes(upload.status) && upload.expiresAt.getTime() <= Date.now()) {
      await this.expireUpload(upload)
      throw new ApiException(410, 'upload_expired', '上传任务已过期')
    }
    if (!ACTIVE_UPLOAD_STATUSES.includes(upload.status)) throw new ApiException(409, 'conflict', '已完成的上传不能取消')
    if (upload.providerUploadId) {
      try {
        await this.storage.abortMultipartUpload(upload.objectKey, upload.providerUploadId)
      } catch (error) {
        if (!isStorageCode(error, 'NoSuchUpload')) throw new ApiException(503, 'storage_unavailable', '对象存储暂时无法取消上传')
      }
    }
    await this.database.uploadSession.updateMany({
      where: { id: upload.id, status: { in: ACTIVE_UPLOAD_STATUSES } },
      data: { status: UploadStatus.CANCELLED, abortedAt: new Date() },
    })
    return { cancelled: true }
  }
}

@Controller('uploads')
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Post() create(@CurrentUser() user: AuthUser, @Body() input: unknown) { return this.uploads.create(user, input) }
  @Get() list(@CurrentUser() user: AuthUser) { return this.uploads.list(user.id) }
  @Get(':uploadId') get(@CurrentUser() user: AuthUser, @Param('uploadId') uploadId: string) { return this.uploads.get(user.id, uploadId) }
  @Post(':uploadId/parts/sign') sign(@CurrentUser() user: AuthUser, @Param('uploadId') uploadId: string, @Body() input: unknown) {
    return this.uploads.signParts(user.id, uploadId, input)
  }
  @Post(':uploadId/parts/:partNumber') record(
    @CurrentUser() user: AuthUser,
    @Param('uploadId') uploadId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Body() input: unknown,
  ) { return this.uploads.recordPart(user.id, uploadId, partNumber, input) }
  @Post(':uploadId/complete') complete(@CurrentUser() user: AuthUser, @Param('uploadId') uploadId: string) {
    return this.uploads.complete(user.id, uploadId)
  }
  @Post(':uploadId/cancel') cancel(@CurrentUser() user: AuthUser, @Param('uploadId') uploadId: string) {
    return this.uploads.cancel(user.id, uploadId)
  }
}

@Module({ controllers: [UploadsController], providers: [UploadsService], exports: [UploadsService] })
export class UploadsModule {}
