import { Global, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { PrismaClient } from '@online-learning/database'
import { SERVER_ENV } from '../config/app-config.module'

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(SERVER_ENV) env: ServerEnv) {
    super({ datasources: { db: { url: env.DATABASE_URL } } })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
