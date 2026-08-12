import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common'
import type { AuthUser } from '@online-learning/contracts'
import type { RequestContext } from './request-context'

export const PUBLIC_ROUTE = 'echoflow:public-route'
export const REQUIRED_ROLES = 'echoflow:required-roles'

export const Public = () => SetMetadata(PUBLIC_ROUTE, true)
export const Roles = (...roles: AuthUser['role'][]) => SetMetadata(REQUIRED_ROLES, roles)

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<RequestContext>().user
})
