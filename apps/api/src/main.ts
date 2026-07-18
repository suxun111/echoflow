import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.enableCors({ origin: true, credentials: true })
  const port = Number(process.env.API_PORT ?? 3001)
  await app.listen(port)
  console.log(`Online Learning API listening on http://localhost:${port}/api`)
}

void bootstrap()
