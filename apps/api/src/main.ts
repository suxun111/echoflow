import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { loadServerEnv } from '@online-learning/config'
import { AppModule } from './app.module'

async function bootstrap() {
  const env = loadServerEnv()
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.enableCors({ origin: env.WEB_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean), credentials: true })
  const port = env.API_PORT
  await app.listen(port)
  console.log(`Online Learning API listening on http://localhost:${port}/api`)
}

void bootstrap()
