import { Controller, Get, Inject, Module } from '@nestjs/common'
import { Roles } from '../../common/auth.decorators'
import { DatabaseService } from '../../database/database.module'

@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get('audit-events')
  async auditEvents() {
    const events = await this.database.auditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, action: true, resourceType: true, resourceId: true, requestId: true, createdAt: true },
    })
    return { items: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })) }
  }
}

@Module({ controllers: [AdminController] })
export class AdminModule {}
