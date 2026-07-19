import type { AuthSession } from '../types'

export type CodeRequestResult = {
  accepted: boolean
  expiresInSeconds: number
  developmentCode?: string
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '')

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const fallback = response.status === 400 ? '提交的信息有误，请检查后重试。' : '服务暂时不可用，请稍后再试。'
    try {
      const data = await response.json() as { message?: string }
      throw new Error(data.message || fallback)
    } catch (error) {
      if (error instanceof Error && error.message !== 'Unexpected end of JSON input') throw error
      throw new Error(fallback)
    }
  }

  return response.json() as Promise<T>
}

export function requestLoginCode(phone: string): Promise<CodeRequestResult> {
  return postJson<CodeRequestResult>('/auth/request-code', { phone })
}

export function verifyLoginCode(phone: string, code: string): Promise<AuthSession> {
  return postJson<AuthSession>('/auth/verify-code', { phone, code })
}
