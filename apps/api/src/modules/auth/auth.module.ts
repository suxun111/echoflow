import { BadRequestException, Body, Controller, Inject, Injectable, Module, Post } from '@nestjs/common'
import { PhoneRequestCodeSchema, PhoneVerifyCodeSchema } from '@online-learning/contracts'

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

@Module({ controllers: [AuthController], providers: [DevAuthService], exports: [DevAuthService] })
export class AuthModule {}
