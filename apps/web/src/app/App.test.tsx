import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { BRAND_NAME } from '../config/brand'
import { saveAuthSession } from '../lib/authSession'

const session = {
  accessToken: 'dev-access.token',
  refreshToken: 'dev-refresh.token',
  user: { id: 'user-1', phone: '13800000000', displayName: '用户0000' },
}

describe('App auth entry', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('lets guests browse the library and opens auth for personal areas', async () => {
    render(<App />)

    expect(screen.getAllByText(BRAND_NAME).length).toBeGreaterThan(0)
    expect(screen.queryByText('EchoFlow')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /学习记录/ }))

    expect(screen.getByRole('heading', { name: `欢迎回到 ${BRAND_NAME}` })).toBeInTheDocument()
    expect(screen.queryByText('EchoFlow')).not.toBeInTheDocument()
  })

  it('restores the learning app from a saved session and can sign out', async () => {
    saveAuthSession(session)
    render(<App />)

    expect(screen.getByText('用户0000')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: `欢迎回到 ${BRAND_NAME}` })).toBeInTheDocument())
  })
})
