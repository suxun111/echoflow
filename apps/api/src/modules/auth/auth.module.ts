import { BadRequestException, Body, Controller, Inject, Injectable, Module, Post, UnauthorizedException } from '@nestjs/common'
import { PhoneRequestCodeSchema, PhoneVerifyCodeSchema } from '@online-learning/contracts'

export type SessionUser = { id: string; phone: string; displayName: string }

type TokenPayload = { sub: string; phone: string; issuedAt: number }

@Injectable()
export class DevAuthService {
  private readonly codes = new Map<string, string>()
  private readonly usersByPhone = new Map<string, SessionUser>()
  private readonly usersById = new Map<string, SessionUser>()
  private nextUserNumber = 1

  requestCode(phone: string) {
    if (!this.allowsDevelopmentSms()) throw new BadRequestException('Production SMS provider is not configured')
    const code = '246810'
    this.codes.set(phone, code)
    console.log(`[dev-sms] ${phone}: ${code}`)
    return { accepted: true, expiresInSeconds: 300, developmentCode: code }
  }

  verify(phone: string, code: string) {
    if (this.codes.get(phone) !== code) throw new BadRequestException('验证码无效或已过期')
    this.codes.delete(phone)
    const user = this.findOrCreateUser(phone)
    return {
      accessToken: this.createToken('dev-access', user),
      refreshToken: this.createToken('dev-refresh', user),
      user,
    }
  }

  refresh(refreshToken?: string) {
    if (!refreshToken) throw new BadRequestException('缺少刷新令牌')
    const user = this.userFromToken(refreshToken, 'dev-refresh')
    return { accessToken: this.createToken('dev-access', user) }
  }

  userFromAuthorization(authorization?: string): SessionUser {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) throw new UnauthorizedException('缺少登录令牌')
    return this.userFromToken(token, 'dev-access')
  }

  private findOrCreateUser(phone: string): SessionUser {
    const existing = this.usersByPhone.get(phone)
    if (existing) return existing

    const user = {
      id: `usr_${String(this.nextUserNumber++).padStart(6, '0')}`,
      phone,
      displayName: `用户${phone.slice(-4)}`,
    }
    this.usersByPhone.set(phone, user)
    this.usersById.set(user.id, user)
    return user
  }

  private allowsDevelopmentSms(): boolean {
    return process.env.NODE_ENV !== 'production' || process.env.npm_lifecycle_event === 'dev'
  }

  private userFromToken(token: string, prefix: 'dev-access' | 'dev-refresh'): SessionUser {
    if (!token.startsWith(`${prefix}.`)) throw new UnauthorizedException('登录令牌无效')
    try {
      const payload = JSON.parse(Buffer.from(token.slice(prefix.length + 1), 'base64url').toString('utf8')) as TokenPayload
      const user = this.usersById.get(payload.sub)
      if (!user || user.phone !== payload.phone) throw new UnauthorizedException('登录令牌无效')
      return user
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error
      throw new UnauthorizedException('登录令牌无效')
    }
  }

  private createToken(prefix: 'dev-access' | 'dev-refresh', user: SessionUser): string {
    const payload: TokenPayload = { sub: user.id, phone: user.phone, issuedAt: Date.now() }
    return `${prefix}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  }
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(DevAuthService) private readonly auth: DevAuthService) {}
  @Post('request-code') requestCode(@Body() input: unknown) { const data = PhoneRequestCodeSchema.parse(input); return this.auth.requestCode(data.phone) }
  @Post('verify-code') verifyCode(@Body() input: unknown) { const data = PhoneVerifyCodeSchema.parse(input); return this.auth.verify(data.phone, data.code) }
  @Post('refresh') refresh(@Body() input: { refreshToken?: string }) { return this.auth.refresh(input.refreshToken) }
}

@Module({ controllers: [AuthController], providers: [DevAuthService], exports: [DevAuthService] })
export class AuthModule {}
