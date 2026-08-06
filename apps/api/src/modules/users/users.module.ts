import { Controller, Get, Module, UseGuards } from '@nestjs/common'
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth/auth.module'

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  @Get('me') me(@CurrentUser() user: AuthenticatedUser) { return { id: user.id, phone: user.phone, displayName: `用户${user.phone.slice(-4)}`, role: user.role, streakDays: 7, dailyGoalMinutes: 30 } }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
