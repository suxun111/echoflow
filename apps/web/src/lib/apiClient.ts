import type { AccessSession, ApiError, AuthUser } from '@online-learning/contracts'

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api/v1'

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly body: ApiError) {
    super(body.message)
  }
}

type TokenListener = (token: string | null, user?: AuthUser) => void

export class ApiClient {
  private accessToken: string | null = null
  private refreshPromise: Promise<AccessSession | null> | null = null

  constructor(private readonly onToken: TokenListener) {}

  setSession(session: AccessSession | null) {
    this.accessToken = session?.accessToken ?? null
    this.onToken(this.accessToken, session?.user)
  }

  async requestOtp(phone: string) {
    return this.fetchJson<{ accepted: true; expiresInSeconds: number; developmentCode?: string }>('/auth/otp/request', {
      method: 'POST', body: JSON.stringify({ phone }),
    }, false)
  }

  async verifyOtp(phone: string, code: string) {
    const session = await this.fetchJson<AccessSession>('/auth/otp/verify', {
      method: 'POST', body: JSON.stringify({ phone, code }),
    }, false)
    this.setSession(session)
    return session
  }

  async restore() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      try {
        const session = await this.fetchJson<AccessSession>('/auth/refresh', { method: 'POST' }, false)
        this.setSession(session)
        return session
      } catch {
        this.setSession(null)
        return null
      }
    })().finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  async logout() {
    try { await this.fetchJson<void>('/auth/logout', { method: 'POST' }, false) } finally { this.setSession(null) }
  }

  async fetchJson<T>(path: string, init: RequestInit = {}, retryAuth = true): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`)
    let response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' })
    if (response.status === 401 && retryAuth && !path.startsWith('/auth/')) {
      const restored = await this.restore()
      if (restored) {
        headers.set('authorization', `Bearer ${restored.accessToken}`)
        response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' })
      }
    }
    if (!response.ok) {
      let body: ApiError
      try { body = await response.json() as ApiError } catch { body = { code: 'internal_error', message: '服务暂时不可用', requestId: 'unavailable' } }
      throw new ApiClientError(response.status, body)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
