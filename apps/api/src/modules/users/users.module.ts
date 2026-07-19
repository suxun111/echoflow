import { Controller, Get, Headers, Inject, Module } from '@nestjs/common'
import { AuthModule, DevAuthService } from '../auth/auth.module'

@Controller('users')
export class UsersController {
  constructor(@Inject(DevAuthService) private readonly auth: DevAuthService) {}

  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    const user = this.auth.userFromAuthorization(authorization)
    return { ...user, streakDays: 7, dailyGoalMinutes: 30 }
  }
}

@Module({ imports: [AuthModule], controllers: [UsersController] })
export class UsersModule {}
