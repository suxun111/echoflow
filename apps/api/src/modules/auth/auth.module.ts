import { BadRequestException, CanActivate, Controller, createParamDecorator, ExecutionContext, Global, HttpException, HttpStatus, Injectable, Inject, Module, OnModuleDestroy, Post, SetMetadata, UnauthorizedException, UseGuards, Body, ServiceUnavailableException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import Redis from 'ioredis'
import { PhoneRequestCodeSchema, PhoneVerifyCodeSchema } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { loadServerEnv } from '@online-learning/config'

export type UserRole = 'learner' | 'editor' | 'admin'
export type AuthenticatedUser = { id: string; phone: string; role: UserRole }

type TokenPayload = AuthenticatedUser & { type: 'access' | 'refresh'; iat: number; exp: number }

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decode<T>(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
}

function hashCode(phone: string, code: string) {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex')
}

function roleFromDatabase(role: string): UserRole {
  return role.toLowerCase() as UserRole
}

@Injectable()
export class TokenService {
  private sign(user: AuthenticatedUser, type: TokenPayload['type'], ttlSeconds: number) {
    const header = encode({ alg: 'HS256', typ: 'JWT' })
    const now = Math.floor(Date.now() / 1000)
    const payload: TokenPayload = { ...user, type, iat: now, exp: now + ttlSeconds }
    const body = `${header}.${encode(payload)}`
    const signature = createHmac('sha256', loadServerEnv().JWT_SECRET).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  issue(user: AuthenticatedUser) {
    const env = loadServerEnv()
    return { accessToken: this.sign(user, 'access', env.JWT_ACCESS_TTL_SECONDS), refreshToken: this.sign(user, 'refresh', env.JWT_REFRESH_TTL_SECONDS) }
  }

  verify(token: string, expectedType: TokenPayload['type'] = 'access'): TokenPayload {
    const [header, payload, signature] = token.split('.')
    if (!header || !payload || !signature) throw new UnauthorizedException('令牌格式无效')
    const expected = createHmac('sha256', loadServerEnv().JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new UnauthorizedException('令牌签名无效')
    const value = decode<TokenPayload>(payload)
    if (value.type !== expectedType || value.exp <= Math.floor(Date.now() / 1000)) throw new UnauthorizedException('令牌已过期或类型不匹配')
    return value
  }
}

@Injectable()
export class DevAuthService {
  // This test-only store keeps the API suite independent from external services. Production always uses VerificationCode and User tables.
  private readonly testCodes = new Map<string, { codeHash: string; expiresAt: number }>()
  private readonly testUsers = new Map<string, AuthenticatedUser>()

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(TokenService) private readonly tokens: TokenService) {}

  async requestCode(phone: string) {
    const env = loadServerEnv()
    if (env.NODE_ENV === 'production') throw new BadRequestException('Production SMS provider is not configured')
    const code = env.NODE_ENV === 'test' ? '246810' : String(randomInt(100000, 1000000))
    const expiresAt = Date.now() + env.AUTH_CODE_TTL_SECONDS * 1000
    if (env.NODE_ENV === 'test') {
      this.testCodes.set(phone, { codeHash: hashCode(phone, code), expiresAt })
    } else {
      await this.database.verificationCode.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } })
      await this.database.verificationCode.create({ data: { phone, codeHash: hashCode(phone, code), expiresAt: new Date(expiresAt) } })
    }
    return { accepted: true, expiresInSeconds: env.AUTH_CODE_TTL_SECONDS, developmentCode: code }
  }

  async verify(phone: string, code: string) {
    const env = loadServerEnv()
    let valid = false
    if (env.NODE_ENV === 'test') {
      const pending = this.testCodes.get(phone)
      valid = Boolean(pending && pending.expiresAt > Date.now() && pending.codeHash === hashCode(phone, code))
      if (valid) this.testCodes.delete(phone)
    } else {
      const pending = await this.database.verificationCode.findFirst({ where: { phone, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
      if (pending) {
        const attempts = pending.attempts + 1
        valid = pending.codeHash === hashCode(phone, code)
        await this.database.verificationCode.update({ where: { id: pending.id }, data: { attempts, ...(valid || attempts >= env.AUTH_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}) } })
      }
    }
    if (!valid) throw new BadRequestException('验证码无效或已过期')

    const user = env.NODE_ENV === 'test'
      ? (this.testUsers.get(phone) ?? { id: `user-${phone}`, phone, role: 'learner' as const })
      : await this.findOrCreateUser(phone)
    if (env.NODE_ENV === 'test') this.testUsers.set(phone, user)
    return { ...this.tokens.issue(user), user: { id: user.id, phone: user.phone, displayName: `用户${phone.slice(-4)}` } }
  }

  async refresh(refreshToken: string) {
    const payload = this.tokens.verify(refreshToken, 'refresh')
    const env = loadServerEnv()
    const user = env.NODE_ENV === 'test' ? this.testUsers.get(payload.phone) : await this.database.user.findUnique({ where: { id: payload.id } }).then((value) => value ? { id: value.id, phone: value.phone, role: roleFromDatabase(value.role) } : null)
    if (!user) throw new UnauthorizedException('用户不存在')
    return { accessToken: this.tokens.issue(user).accessToken }
  }

  private async findOrCreateUser(phone: string): Promise<AuthenticatedUser> {
    const user = await this.database.user.upsert({ where: { phone }, update: {}, create: { phone, displayName: `用户${phone.slice(-4)}` } })
    return { id: user.id, phone: user.phone, role: roleFromDatabase(user.role) }
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string }; user?: AuthenticatedUser }>()
    const value = request.headers.authorization
    if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('请先登录')
    request.user = this.tokens.verify(value.slice(7))
    return true
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user)
export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles)

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<UserRole[]>('roles', [context.getHandler(), context.getClass()])
    if (!roles?.length) return true
    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user
    if (!user || !roles.includes(user.role)) throw new UnauthorizedException('没有访问权限')
    return true
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly redis: Redis | null
  private connecting: Promise<void> | undefined

  constructor() {
    this.redis = process.env.NODE_ENV === 'test' ? null : new Redis(loadServerEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 })
  }

  async canActivate(context: ExecutionContext) {
    if (!this.redis) return true
    const request = context.switchToHttp().getRequest<{ ip?: string; path?: string }>()
    try {
      if (this.redis.status !== 'ready') {
        this.connecting ??= this.redis.connect().finally(() => { this.connecting = undefined })
        await this.connecting
      }
      const env = loadServerEnv()
      const path = request.path ?? 'unknown'
      const limit = path.includes('/auth/') ? 10 : env.RATE_LIMIT_MAX_REQUESTS
      const key = `rate-limit:${path}:${request.ip ?? 'unknown'}`
      const count = await this.redis.incr(key)
      if (count === 1) await this.redis.expire(key, env.RATE_LIMIT_WINDOW_SECONDS)
      if (count > limit) throw new HttpException('请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
      return true
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error
      if (loadServerEnv().NODE_ENV === 'production') throw new ServiceUnavailableException('限流依赖暂不可用')
      return true
    }
  }

  onModuleDestroy() { this.redis?.disconnect() }
}

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(@Inject(DevAuthService) private readonly auth: DevAuthService) {}
  @Post('request-code') requestCode(@Body() input: unknown) { const data = PhoneRequestCodeSchema.parse(input); return this.auth.requestCode(data.phone) }
  @Post('verify-code') verifyCode(@Body() input: unknown) { const data = PhoneVerifyCodeSchema.parse(input); return this.auth.verify(data.phone, data.code) }
  @Post('refresh') refresh(@Body() input: { refreshToken?: string }) { if (!input.refreshToken) throw new BadRequestException('缺少刷新令牌'); return this.auth.refresh(input.refreshToken) }
}

@Global()
@Module({ controllers: [AuthController], providers: [DevAuthService, TokenService, AuthGuard, RolesGuard, RateLimitGuard, Reflector], exports: [DevAuthService, TokenService, AuthGuard, RolesGuard, RateLimitGuard] })
export class AuthModule {}
