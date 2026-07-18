import { Controller, Get, Module } from '@nestjs/common'

@Controller('health')
export class HealthController {
  @Get() check() { return { status: 'ok', service: 'online-learning-api', timestamp: new Date().toISOString() } }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
