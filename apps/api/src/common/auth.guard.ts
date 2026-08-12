import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthUser } from '@online-learning/contracts'
import { ApiException } from './api-exception'
import { PUBLIC_ROUTE, REQUIRED_ROLES } from './auth.decorators'
import type { RequestContext } from './request-context'
import { AuthService } from '../modules/auth/auth.service'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest<RequestContext>()
    const authorization = request.headers.authorization
    const header = Array.isArray(authorization) ? authorization[0] : authorization
    if (!header?.startsWith('Bearer ')) throw new ApiException(401, 'unauthenticated', '需要有效的 Access Token')

    request.user = await this.auth.authenticateAccessToken(header.slice(7))
    const roles = this.reflector.getAllAndOverride<AuthUser['role'][]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()])
    if (roles?.length && !roles.includes(request.user.role)) throw new ApiException(403, 'forbidden', '当前账号无权执行此操作')
    return true
  }
}
