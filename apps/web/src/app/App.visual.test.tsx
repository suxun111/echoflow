import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('EchoFlow visual baseline', () => {
  it('starts from the real private-session boundary without retired decoration hooks', async () => {
    render(<App />)

    expect(await screen.findByText('继续你的学习空间')).toBeInTheDocument()
    expect(document.querySelector('.featured-halftone')).not.toBeInTheDocument()
    expect(screen.queryByText('生词本')).not.toBeInTheDocument()
  })
})
