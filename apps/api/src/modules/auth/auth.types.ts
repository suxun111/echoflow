import type { AuthUser } from '@online-learning/contracts'

export type AuthenticatedUser = AuthUser & { sessionFamilyId: string }

export type ClientMetadata = {
  requestId: string
  userAgent?: string
  ip?: string
}
