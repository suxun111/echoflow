import { Controller, Get, Module } from '@nestjs/common'

@Controller('users')
export class UsersController {
  @Get('me') me() { return { id: 'demo-user', phone: '138****0000', displayName: 'Lena', streakDays: 7, dailyGoalMinutes: 30 } }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
