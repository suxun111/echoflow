import type { AuthSession } from '../types'

const SESSION_KEY = 'echoflow:auth-session:v1'

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false
  const session = value as AuthSession
  return typeof session.accessToken === 'string'
    && typeof session.refreshToken === 'string'
    && !!session.user
    && typeof session.user.id === 'string'
    && typeof session.user.phone === 'string'
    && typeof session.user.displayName === 'string'
}

export function loadAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return isAuthSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveAuthSession(session: AuthSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearAuthSession(): void {
  localStorage.removeItem(SESSION_KEY)
}
