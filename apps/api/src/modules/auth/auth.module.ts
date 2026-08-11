import { BadRequestException, Body, CanActivate, Controller, createParamDecorator, ExecutionContext, Inject, Injectable, Module, Post, UnauthorizedException } from '@nestjs/common'
import { loadServerEnv } from '@online-learning/config'
import { PhoneRequestCodeSchema, PhoneVerifyCodeSchema } from '@online-learning/contracts'

export type DevUser = { id: string; phone: string; displayName: string }
export type DevRequest = { headers: Record<string, string | string[] | undefined>; devUser?: DevUser }

export const CurrentDevUser = createParamDecorator((_data: unknown, context: ExecutionContext): DevUser => {
  return context.switchToHttp().getRequest<DevRequest>().devUser as DevUser
})

@Injectable()
export class DevIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<DevRequest>()
    const authorization = request.headers.authorization
    const token = Array.isArray(authorization) ? authorization[0] : authorization
    if (!token?.startsWith('Bearer dev-access.')) throw new UnauthorizedException('本地私有课程需要开发者身份')
    const env = loadServerEnv()
    request.devUser = { id: env.DEV_USER_ID, phone: env.DEV_USER_PHONE, displayName: env.DEV_USER_DISPLAY_NAME }
    return true
  }
}

@Injectable()
export class DevAuthService {
  private readonly codes = new Map<string, string>()
  requestCode(phone: string) {
    if (process.env.NODE_ENV === 'production') throw new BadRequestException('Production SMS provider is not configured')
    const code = '246810'
    this.codes.set(phone, code)
    console.log(`[dev-sms] ${phone}: ${code}`)
    return { accepted: true, expiresInSeconds: 300, developmentCode: code }
  }
  verify(phone: string, code: string) {
    if (this.codes.get(phone) !== code) throw new BadRequestException('验证码无效或已过期')
    this.codes.delete(phone)
    const tokenSeed = Buffer.from(`${phone}:${Date.now()}`).toString('base64url')
    return { accessToken: `dev-access.${tokenSeed}`, refreshToken: `dev-refresh.${tokenSeed}`, user: { id: `user-${phone}`, phone, displayName: `用户${phone.slice(-4)}` } }
  }
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(DevAuthService) private readonly auth: DevAuthService) {}
  @Post('request-code') requestCode(@Body() input: unknown) { const data = PhoneRequestCodeSchema.parse(input); return this.auth.requestCode(data.phone) }
  @Post('verify-code') verifyCode(@Body() input: unknown) { const data = PhoneVerifyCodeSchema.parse(input); return this.auth.verify(data.phone, data.code) }
  @Post('refresh') refresh(@Body() input: { refreshToken?: string }) { if (!input.refreshToken) throw new BadRequestException('缺少刷新令牌'); return { accessToken: input.refreshToken.replace('dev-refresh.', 'dev-access.') } }
}

@Module({ controllers: [AuthController], providers: [DevAuthService, DevIdentityGuard], exports: [DevAuthService, DevIdentityGuard] })
export class AuthModule {}
