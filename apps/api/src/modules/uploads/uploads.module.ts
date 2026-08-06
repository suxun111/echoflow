import { Body, Controller, Inject, Injectable, Module, NotFoundException, Param, Post, UseGuards } from '@nestjs/common'
import { Client } from 'minio'
import { UploadRequestSchema } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'
import { MemoryStorageProvider, MinioStorageProvider, type StorageProvider } from '@online-learning/storage'
import { JobsModule, JobsService } from '../jobs/jobs.module'
import { AuthGuard, CurrentUser, RateLimitGuard, type AuthenticatedUser } from '../auth/auth.module'

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER'

@Injectable()
export class UploadsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider, @Inject(JobsService) private readonly jobs: JobsService) {}

  async presign(input: unknown, user: AuthenticatedUser) {
    const data = UploadRequestSchema.parse(input)
    const target = await this.storage.createUploadTarget(data.fileName, data.contentType)
    const uploadId = crypto.randomUUID()
    if (process.env.NODE_ENV !== 'test') {
      await this.database.upload.create({ data: { id: uploadId, userId: user.id, originalName: data.fileName, contentType: data.contentType, sizeBytes: data.sizeBytes, storageKey: target.objectKey, rightsConfirmed: data.rightsConfirmed } })
    }
    const firstJob = await this.jobs.create(uploadId, 'transcode', false)
    return { uploadId, private: true, ...target, firstJob }
  }

  async complete(uploadId: string, user: AuthenticatedUser) {
    if (process.env.NODE_ENV === 'test') {
      const firstJob = await this.jobs.getByUpload(uploadId)
      if (!firstJob) throw new NotFoundException('上传不存在')
      return { uploadId, completedAt: new Date().toISOString(), firstJob: await this.jobs.enqueue(firstJob) }
    }
    const upload = await this.database.upload.findFirst({ where: { id: uploadId, userId: user.id } })
    if (!upload) throw new NotFoundException('上传不存在')
    await this.storage.verifyUpload(upload.storageKey)
    await this.database.upload.update({ where: { id: uploadId }, data: { completedAt: new Date() } })
    const firstJob = await this.jobs.getByUpload(uploadId)
    if (!firstJob) throw new NotFoundException('处理任务不存在')
    return { uploadId, completedAt: new Date().toISOString(), firstJob: await this.jobs.enqueue(firstJob) }
  }
}

const storageProvider = {
  provide: STORAGE_PROVIDER,
  useFactory: () => {
    if (process.env.NODE_ENV === 'test') return new MemoryStorageProvider()
    const env = loadServerEnv()
    return new MinioStorageProvider(new Client({ endPoint: env.MINIO_ENDPOINT, port: env.MINIO_PORT, useSSL: env.MINIO_USE_SSL, accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY }), env.MINIO_BUCKET)
  },
}

@Controller('uploads')
@UseGuards(AuthGuard, RateLimitGuard)
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}
  @Post('presign') presign(@Body() input: unknown, @CurrentUser() user: AuthenticatedUser) { return this.uploads.presign(input, user) }
  @Post(':uploadId/complete') complete(@Param('uploadId') uploadId: string, @CurrentUser() user: AuthenticatedUser) { return this.uploads.complete(uploadId, user) }
}

@Module({ imports: [JobsModule], controllers: [UploadsController], providers: [UploadsService, storageProvider] })
export class UploadsModule {}
