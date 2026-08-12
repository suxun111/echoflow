import { Controller, Get, Module } from '@nestjs/common'
import type { AuthUser } from '@online-learning/contracts'
import { CurrentUser } from '../../common/auth.decorators'
import type { AuthenticatedUser } from '../auth/auth.types'

@Controller('users')
export class UsersController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthUser {
    const { sessionFamilyId: _sessionFamilyId, ...publicUser } = user
    return publicUser
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
