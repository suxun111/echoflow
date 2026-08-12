import { DynamicModule, Global, Module } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'

export const SERVER_ENV = Symbol('SERVER_ENV')

@Global()
@Module({})
export class AppConfigModule {
  static forRoot(env: ServerEnv): DynamicModule {
    return {
      global: true,
      module: AppConfigModule,
      providers: [{ provide: SERVER_ENV, useValue: env }],
      exports: [SERVER_ENV],
    }
  }
}
