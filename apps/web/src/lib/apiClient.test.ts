import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './apiClient'

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  phone: '+8613900000001',
  displayName: 'Learner',
  role: 'learner' as const,
  status: 'active' as const,
}

describe('ApiClient refresh coordination', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('coalesces concurrent 401 responses into one rotating-cookie refresh', async () => {
    let refreshCalls = 0
    let protectedCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return Response.json({ accessToken: 'fresh', expiresInSeconds: 900, user })
      }
      protectedCalls += 1
      if (protectedCalls <= 2) return Response.json({ code: 'unauthenticated', message: 'expired', requestId: 'test' }, { status: 401 })
      return Response.json({ ok: true })
    }))
    const client = new ApiClient(() => undefined)
    client.setSession({ accessToken: 'expired', expiresInSeconds: 1, user })

    await expect(Promise.all([
      client.fetchJson('/uploads'),
      client.fetchJson('/media-assets'),
    ])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(refreshCalls).toBe(1)
    expect(protectedCalls).toBe(4)
  })
})
