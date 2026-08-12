import { DynamicModule, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import type { ServerEnv } from '@online-learning/config'
import { AuthGuard } from './common/auth.guard'
import { AppConfigModule } from './config/app-config.module'
import { DatabaseModule } from './database/database.module'
import { AdminModule } from './modules/admin/admin.module'
import { AuthModule } from './modules/auth/auth.module'
import { HealthModule } from './modules/health/health.module'
import { LessonsModule } from './modules/lessons/lessons.module'
import { UsersModule } from './modules/users/users.module'

@Module({})
export class AppModule {
  static register(env: ServerEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [AppConfigModule.forRoot(env), DatabaseModule, HealthModule, AuthModule, UsersModule, LessonsModule, AdminModule],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    }
  }
}
