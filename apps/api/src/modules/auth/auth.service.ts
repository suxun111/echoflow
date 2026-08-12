import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { AccessSessionSchema, AuthUserSchema, type AccessSession, type AuthUser } from '@online-learning/contracts'
import { Prisma, UserRole, UserStatus, type User } from '@online-learning/database'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { ApiException } from '../../common/api-exception'
import { SERVER_ENV } from '../../config/app-config.module'
import { DatabaseService } from '../../database/database.module'
import type { AuthenticatedUser, ClientMetadata } from './auth.types'
import { OTP_DELIVERY, type OtpDeliveryPort } from './otp-delivery'

const AccessIssuer = 'echoflow-api'
const AccessAudience = 'echoflow-web'

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    @Inject(OTP_DELIVERY) private readonly otpDelivery: OtpDeliveryPort,
  ) {}

  async requestOtp(phone: string, requestId: string) {
    const now = new Date()
    const notBefore = new Date(now.getTime() - this.env.OTP_MIN_REQUEST_INTERVAL_SECONDS * 1000)
    const id = randomUUID()
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    const expiresAt = new Date(now.getTime() + this.env.OTP_TTL_SECONDS * 1000)
    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phone}, 0))`
      const recent = await transaction.otpChallenge.findFirst({
        where: { phone, createdAt: { gt: notBefore } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (recent) throw new ApiException(429, 'rate_limited', '验证码请求过于频繁，请稍后再试')

      await transaction.otpChallenge.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: now },
      })
      await transaction.otpChallenge.create({
        data: {
          id,
          phone,
          codeHash: this.hashOtp(id, phone, code),
          expiresAt,
          maxAttempts: this.env.OTP_MAX_ATTEMPTS,
          requestId,
        },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    let delivery: { developmentCode?: string }
    try {
      delivery = await this.otpDelivery.deliver({ phone, code, expiresAt })
    } catch (error) {
      await this.database.otpChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } })
      throw error
    }

    return {
      accepted: true as const,
      expiresInSeconds: this.env.OTP_TTL_SECONDS,
      ...delivery,
    }
  }

  async verifyOtp(phone: string, code: string, metadata: ClientMetadata) {
    const challenge = await this.database.otpChallenge.findFirst({
      where: { phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (!challenge) throw new ApiException(401, 'unauthenticated', '验证码无效或已使用')

    const now = new Date()
    if (challenge.expiresAt <= now) {
      await this.database.otpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } })
      throw new ApiException(401, 'unauthenticated', '验证码已过期')
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      throw new ApiException(401, 'unauthenticated', '验证码尝试次数已用尽')
    }

    const expected = Buffer.from(challenge.codeHash, 'hex')
    const received = Buffer.from(this.hashOtp(challenge.id, phone, code), 'hex')
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      const incremented = await this.database.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } },
        data: { attempts: { increment: 1 } },
      })
      if (incremented.count === 1) {
        const updated = await this.database.otpChallenge.findUniqueOrThrow({ where: { id: challenge.id }, select: { attempts: true } })
        if (updated.attempts >= challenge.maxAttempts) {
          await this.database.otpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } })
        }
      }
      throw new ApiException(401, 'unauthenticated', '验证码无效')
    }

    const refreshToken = this.createOpaqueToken()
    const sessionId = randomUUID()
    const familyId = randomUUID()
    const expiresAt = new Date(now.getTime() + this.env.REFRESH_SESSION_TTL_SECONDS * 1000)
    const user = await this.database.$transaction(async (transaction) => {
      const consumed = await transaction.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } },
        data: { consumedAt: now },
      })
      if (consumed.count !== 1) throw new ApiException(409, 'conflict', '验证码已被消费')

      const authenticated = await transaction.user.upsert({
        where: { phone },
        update: {},
        create: { phone, displayName: `用户${phone.slice(-4)}` },
      })
      if (authenticated.status !== UserStatus.ACTIVE) throw new ApiException(403, 'forbidden', '账号不可用')

      await transaction.refreshSession.create({
        data: {
          id: sessionId,
          userId: authenticated.id,
          familyId,
          tokenHash: this.hashRefreshToken(refreshToken),
          expiresAt,
          userAgentHash: this.hashOptional(metadata.userAgent),
          ipHash: this.hashOptional(metadata.ip),
        },
      })
      await transaction.auditEvent.create({
        data: { actorId: authenticated.id, action: 'auth.login', resourceType: 'RefreshSession', resourceId: sessionId, requestId: metadata.requestId, metadata: {} },
      })
      return authenticated
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return { response: this.createAccessSession(user, familyId), refreshToken }
  }

  async refresh(refreshToken: string, metadata: ClientMetadata) {
    const tokenHash = this.hashRefreshToken(refreshToken)
    const now = new Date()
    const nextToken = this.createOpaqueToken()
    const nextId = randomUUID()
    const nextExpiresAt = new Date(now.getTime() + this.env.REFRESH_SESSION_TTL_SECONDS * 1000)
    const result = await this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "RefreshSession" WHERE "tokenHash" = ${tokenHash} FOR UPDATE
      `
      if (locked.length === 0) return { kind: 'invalid' as const }

      const session = await transaction.refreshSession.findUniqueOrThrow({ where: { id: locked[0].id }, include: { user: true } })
      if (session.rotatedAt) {
        await transaction.refreshSession.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: now },
        })
        await transaction.auditEvent.create({
          data: { actorId: session.userId, action: 'auth.refresh_replay', resourceType: 'RefreshSession', resourceId: session.id, requestId: metadata.requestId, metadata: {} },
        })
        return { kind: 'replay' as const }
      }
      if (session.revokedAt || session.expiresAt <= now || session.user.status !== UserStatus.ACTIVE) {
        return { kind: 'invalid' as const }
      }

      await transaction.refreshSession.create({
        data: {
          id: nextId,
          userId: session.userId,
          familyId: session.familyId,
          tokenHash: this.hashRefreshToken(nextToken),
          expiresAt: nextExpiresAt,
          userAgentHash: this.hashOptional(metadata.userAgent),
          ipHash: this.hashOptional(metadata.ip),
        },
      })
      await transaction.refreshSession.update({
        where: { id: session.id },
        data: { rotatedAt: now, lastUsedAt: now, replacedById: nextId },
      })
      return { kind: 'rotated' as const, user: session.user, familyId: session.familyId }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })

    if (result.kind === 'replay') throw new ApiException(401, 'unauthenticated', '检测到 Refresh Token 重放，会话已撤销')
    if (result.kind === 'invalid') throw new ApiException(401, 'unauthenticated', 'Refresh Session 已失效')

    return { response: this.createAccessSession(result.user, result.familyId), refreshToken: nextToken }
  }

  async logout(refreshToken: string | undefined, metadata: ClientMetadata) {
    if (!refreshToken) return
    const session = await this.database.refreshSession.findUnique({ where: { tokenHash: this.hashRefreshToken(refreshToken) } })
    if (!session) return
    const now = new Date()
    await this.database.$transaction([
      this.database.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } }),
      this.database.auditEvent.create({
        data: { actorId: session.userId, action: 'auth.logout', resourceType: 'RefreshSession', resourceId: session.id, requestId: metadata.requestId, metadata: {} },
      }),
    ])
  }

  async authenticateAccessToken(token: string): Promise<AuthenticatedUser> {
    let payload: JwtPayload
    try {
      const verified = jwt.verify(token, this.env.ACCESS_TOKEN_SECRET, {
        algorithms: ['HS256'], issuer: AccessIssuer, audience: AccessAudience,
      })
      if (typeof verified === 'string') throw new Error('Unexpected JWT payload')
      payload = verified
    } catch {
      throw new ApiException(401, 'unauthenticated', 'Access Token 无效或已过期')
    }
    const userId = payload.sub
    const familyId = typeof payload.familyId === 'string' ? payload.familyId : undefined
    if (!userId || !familyId) throw new ApiException(401, 'unauthenticated', 'Access Token 缺少必要声明')

    const user = await this.database.user.findFirst({
      where: {
        id: userId,
        status: UserStatus.ACTIVE,
        refreshSessions: { some: { familyId, revokedAt: null, expiresAt: { gt: new Date() } } },
      },
    })
    if (!user) throw new ApiException(401, 'unauthenticated', '会话已撤销或账号不可用')
    return { ...this.toAuthUser(user), sessionFamilyId: familyId }
  }

  private createAccessSession(user: User, familyId: string): AccessSession {
    const authUser = this.toAuthUser(user)
    const accessToken = jwt.sign(
      { role: authUser.role, familyId },
      this.env.ACCESS_TOKEN_SECRET,
      {
        algorithm: 'HS256', issuer: AccessIssuer, audience: AccessAudience, subject: user.id,
        expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS, jwtid: randomUUID(),
      },
    )
    return AccessSessionSchema.parse({ accessToken, expiresInSeconds: this.env.ACCESS_TOKEN_TTL_SECONDS, user: authUser })
  }

  private toAuthUser(user: User): AuthUser {
    return AuthUserSchema.parse({
      id: user.id,
      phone: user.phone,
      displayName: user.displayName,
      role: user.role === UserRole.ADMIN ? 'admin' : 'learner',
      status: user.status.toLowerCase(),
    })
  }

  private hashOtp(id: string, phone: string, code: string) {
    return createHmac('sha256', this.env.OTP_HMAC_SECRET).update(`${id}:${phone}:${code}`).digest('hex')
  }

  private hashRefreshToken(token: string) {
    return createHmac('sha256', this.env.REFRESH_TOKEN_PEPPER).update(token).digest('hex')
  }

  private createOpaqueToken() {
    return randomBytes(32).toString('base64url')
  }

  private hashOptional(value: string | undefined) {
    return value
      ? createHmac('sha256', this.env.REFRESH_TOKEN_PEPPER).update(`client-metadata:${value}`).digest('hex')
      : undefined
  }
}
