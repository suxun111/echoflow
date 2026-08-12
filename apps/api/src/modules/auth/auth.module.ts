import { Body, Controller, Headers, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { OtpRequestResponseSchema, OtpRequestSchema, OtpVerifySchema } from '@online-learning/contracts'
import { parse, serialize } from 'cookie'
import { ApiException } from '../../common/api-exception'
import { Public } from '../../common/auth.decorators'
import type { RequestContext } from '../../common/request-context'
import { SERVER_ENV } from '../../config/app-config.module'
import { AuthService } from './auth.service'
import { ExplicitTestOtpDelivery, OTP_DELIVERY } from './otp-delivery'

const RefreshCookieName = 'echoflow_refresh'

type CookieResponse = { setHeader(name: string, value: string): void }

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  @Post('otp/request')
  @HttpCode(200)
  async requestCode(@Body() input: unknown, @Req() request: RequestContext) {
    const { phone } = OtpRequestSchema.parse(input)
    return OtpRequestResponseSchema.parse(await this.auth.requestOtp(phone, request.requestId!))
  }

  @Post('otp/verify')
  @HttpCode(200)
  async verifyCode(
    @Body() input: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: CookieResponse,
    @Headers('user-agent') userAgent?: string,
  ) {
    const { phone, code } = OtpVerifySchema.parse(input)
    const result = await this.auth.verifyOtp(phone, code, this.metadata(request, userAgent))
    response.setHeader('set-cookie', this.refreshCookie(result.refreshToken))
    return result.response
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: CookieResponse,
    @Headers('user-agent') userAgent?: string,
  ) {
    const token = this.readRefreshCookie(request)
    if (!token) return this.failMissingCookie()
    const result = await this.auth.refresh(token, this.metadata(request, userAgent))
    response.setHeader('set-cookie', this.refreshCookie(result.refreshToken))
    return result.response
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: CookieResponse,
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.auth.logout(this.readRefreshCookie(request), this.metadata(request, userAgent))
    response.setHeader('set-cookie', serialize(RefreshCookieName, '', this.cookieOptions(0)))
  }

  private readRefreshCookie(request: RequestContext) {
    const raw = request.headers.cookie
    const header = Array.isArray(raw) ? raw[0] : raw
    return header ? parse(header)[RefreshCookieName] : undefined
  }

  private refreshCookie(token: string) {
    return serialize(RefreshCookieName, token, this.cookieOptions(this.env.REFRESH_SESSION_TTL_SECONDS))
  }

  private cookieOptions(maxAge: number) {
    return { httpOnly: true, secure: this.env.REFRESH_COOKIE_SECURE, sameSite: 'lax' as const, path: '/api/v1/auth', maxAge }
  }

  private metadata(request: RequestContext, userAgent?: string) {
    return { requestId: request.requestId!, userAgent, ip: request.ip }
  }

  private failMissingCookie(): never {
    throw new ApiException(401, 'unauthenticated', '缺少 Refresh Session Cookie')
  }
}

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    ExplicitTestOtpDelivery,
    { provide: OTP_DELIVERY, useExisting: ExplicitTestOtpDelivery },
  ],
  exports: [AuthService],
})
export class AuthModule {}
