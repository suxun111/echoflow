import { Controller, Get, Injectable, Module, ServiceUnavailableException } from '@nestjs/common'
import Redis from 'ioredis'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'

@Injectable()
export class HealthService {
  constructor(private readonly database: DatabaseService) {}

  async readiness() {
    if (process.env.NODE_ENV === 'test') return { status: 'ok', checks: { database: 'skipped-test', redis: 'skipped-test', moss: 'skipped-test' } }
    const checks: Record<string, string> = {}
    try {
      await this.database.$queryRaw`SELECT 1`
      checks.database = 'ok'
    } catch {
      checks.database = 'failed'
    }
    const redis = new Redis(loadServerEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 })
    try {
      await redis.connect()
      await redis.ping()
      checks.redis = 'ok'
    } catch {
      checks.redis = 'failed'
    } finally {
      redis.disconnect()
    }
    const env = loadServerEnv()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), env.MOSS_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${env.MOSS_BASE_URL.replace(/\/$/, '')}/api/runtime`, { signal: controller.signal })
      checks.moss = response.ok ? 'ok' : 'failed'
    } catch {
      checks.moss = 'failed'
    } finally {
      clearTimeout(timer)
    }
    const status = Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'failed'
    return { status, checks }
  }
}

@Controller('health')
export class HealthController {
  @Get() check() { return { status: 'ok', service: 'online-learning-api', timestamp: new Date().toISOString() } }
  @Get('live') live() { return { status: 'ok', service: 'online-learning-api', timestamp: new Date().toISOString() } }
  @Get('ready') async ready() {
    const result = await this.health.readiness()
    if (result.status !== 'ok') throw new ServiceUnavailableException(result)
    return result
  }
  constructor(private readonly health: HealthService) {}
}

@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}
