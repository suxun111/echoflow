import 'reflect-metadata'
import { loadServerEnv } from '@online-learning/config'
import { createApplication } from './bootstrap'

try {
  process.loadEnvFile?.()
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

async function bootstrap() {
  const env = loadServerEnv()
  const app = await createApplication(env)
  app.enableShutdownHooks()
  await app.listen(env.API_PORT, env.API_HOST)
  console.log(`EchoFlow API listening on http://${env.API_HOST}:${env.API_PORT}/api/v1`)
}

void bootstrap()
