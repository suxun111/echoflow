import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { loadServerEnv } from '@online-learning/config'
import { AppModule } from './app.module'
import { ApiExceptionFilter } from './common/api-exception.filter'
import { RequestIdMiddleware } from './common/request-id.middleware'

async function bootstrap() {
  const env = loadServerEnv()
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.use(new RequestIdMiddleware().use)
  app.useGlobalFilters(new ApiExceptionFilter())
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }))
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  app.enableCors({ origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => callback(null, !origin || allowedOrigins.includes(origin)), credentials: true })
  app.enableShutdownHooks()
  const port = env.API_PORT
  await app.listen(port)
  console.log(JSON.stringify({ level: 'info', event: 'api_started', service: 'online-learning-api', port, queue: env.MEDIA_QUEUE_NAME }))
}

void bootstrap()
