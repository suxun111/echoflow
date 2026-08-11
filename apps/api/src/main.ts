import 'reflect-metadata'
import { loadEnvFile } from 'node:process'
import { NestFactory } from '@nestjs/core'
import { loadServerEnv } from '@online-learning/config'
import { AppModule } from './app.module'

try { loadEnvFile() } catch {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.enableCors({ origin: true, credentials: true })
  const port = loadServerEnv().API_PORT
  await app.listen(port)
  console.log(`Online Learning API listening on http://localhost:${port}/api`)
}

void bootstrap()
