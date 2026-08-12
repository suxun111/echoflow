import { Global, Inject, Injectable, Module } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { MinioStorageProvider } from '@online-learning/storage'
import { SERVER_ENV } from '../config/app-config.module'

@Injectable()
export class StorageService extends MinioStorageProvider {
  constructor(@Inject(SERVER_ENV) env: ServerEnv) {
    super({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
    })
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
