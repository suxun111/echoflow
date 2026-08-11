import { Injectable, Module, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { loadServerEnv } from '@online-learning/config'
import { createMinioStorageProvider, type StorageProvider } from '@online-learning/storage'

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER')

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() {
    await this.$disconnect()
  }
}

function createStorageProvider(): StorageProvider {
  const env = loadServerEnv()
  return createMinioStorageProvider({
    endpoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    bucket: env.MINIO_BUCKET,
  })
}

@Module({
  providers: [PrismaService, { provide: STORAGE_PROVIDER, useFactory: createStorageProvider }],
  exports: [PrismaService, STORAGE_PROVIDER],
})
export class InfrastructureModule {}
