import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthPage } from './AuthPage'
import { BRAND_NAME } from '../../config/brand'

const authSession = {
  accessToken: 'dev-access.token',
  refreshToken: 'dev-refresh.token',
  user: { id: 'user-1', phone: '13800000000', displayName: '用户0000' },
}

describe('AuthPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('validates phone numbers before requesting a code', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<AuthPage onAuthenticated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }))

    expect(await screen.findByText('请输入 11 位中国大陆手机号。')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests a development code and starts the countdown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      accepted: true,
      expiresInSeconds: 300,
      developmentCode: '246810',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    render(<AuthPage onAuthenticated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800000000' } })
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }))

    expect(await screen.findByText('开发环境验证码：246810')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '60 秒后重试' })).toBeDisabled()
  })

  it('verifies the code and returns the authenticated session', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, expiresInSeconds: 300, developmentCode: '246810' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(authSession), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    const onAuthenticated = vi.fn()
    render(<AuthPage onAuthenticated={onAuthenticated} />)

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800000000' } })
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }))
    await screen.findByText('开发环境验证码：246810')
    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '246810' } })
    fireEvent.click(screen.getByRole('button', { name: `登录 ${BRAND_NAME}` }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(authSession))
  })

  it('uses the configured site name without showing the old brand', () => {
    render(<AuthPage onAuthenticated={vi.fn()} />)

    expect(screen.getByText(BRAND_NAME)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: `欢迎回到 ${BRAND_NAME}` })).toBeInTheDocument()
    expect(screen.queryByText('EchoFlow')).not.toBeInTheDocument()
  })
})
