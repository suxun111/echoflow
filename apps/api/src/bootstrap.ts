import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { ServerEnv } from '@online-learning/config'
import { AppModule } from './app.module'
import { ApiExceptionFilter } from './common/api-exception.filter'
import { installRequestContext } from './common/request-context'

export async function createApplication(env: ServerEnv): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(env), {
    abortOnError: false,
    logger: env.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'],
  })
  app.setGlobalPrefix('api/v1')
  app.enableCors({
    credentials: true,
    origin(origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) {
      callback(null, !origin || env.CORS_ALLOWED_ORIGINS.includes(origin))
    },
  })
  installRequestContext(app, env.NODE_ENV !== 'test')
  app.useGlobalFilters(new ApiExceptionFilter())
  await app.init()
  return app
}
