import { beforeEach, describe, expect, it } from 'vitest'
import { clearAuthSession, loadAuthSession, saveAuthSession } from './authSession'

const session = {
  accessToken: 'dev-access.token',
  refreshToken: 'dev-refresh.token',
  user: { id: 'user-1', phone: '13800000000', displayName: '用户0000' },
}

describe('auth session storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when no session has been saved', () => {
    expect(loadAuthSession()).toBeNull()
  })

  it('persists and clears the current auth session', () => {
    saveAuthSession(session)

    expect(loadAuthSession()).toEqual(session)

    clearAuthSession()

    expect(loadAuthSession()).toBeNull()
  })
})
