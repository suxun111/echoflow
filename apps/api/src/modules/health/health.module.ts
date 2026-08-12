import { Controller, Get, Inject, Module } from '@nestjs/common'
import { ApiException } from '../../common/api-exception'
import { Public } from '../../common/auth.decorators'
import { DatabaseService } from '../../database/database.module'

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get()
  live() {
    return { status: 'ok', service: 'echoflow-api', timestamp: new Date().toISOString() }
  }

  @Get('ready')
  async ready() {
    try {
      await this.database.$queryRawUnsafe('SELECT 1')
      return { status: 'ready', database: 'connected', timestamp: new Date().toISOString() }
    } catch {
      throw new ApiException(503, 'service_unavailable', '数据库暂不可用')
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
