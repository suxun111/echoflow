import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlatformShell } from './PlatformShell'

describe('PlatformShell mobile navigation', () => {
  it('exposes the private uploads entry and routes it through onView', () => {
    const onView = vi.fn()

    render(<PlatformShell view="home" search="" onSearch={() => undefined} onView={onView} onUpload={() => undefined}><main>内容</main></PlatformShell>)

    const mobileNav = screen.getByRole('navigation', { name: '移动端主导航' })
    const uploadsButton = screen.getByRole('button', { name: '个人上传' })

    expect(mobileNav).toBeInTheDocument()
    expect(uploadsButton).not.toHaveAttribute('aria-current')

    fireEvent.click(uploadsButton)
    expect(onView).toHaveBeenCalledWith('uploads')
  })

  it('marks the current uploads view active without changing the desktop navigation contract', () => {
    render(<PlatformShell view="uploads" search="" onSearch={() => undefined} onView={() => undefined} onUpload={() => undefined}><main>内容</main></PlatformShell>)

    expect(screen.getByRole('button', { name: '个人上传' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上传视频' })).toBeInTheDocument()
  })
})
