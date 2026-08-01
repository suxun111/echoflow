import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('EchoFlow visual baseline', () => {
  it('renders the library without the retired pop-art decoration hooks', () => {
    render(<App />)

    expect(document.querySelector('.library-page')).not.toHaveAttribute('data-visual-theme')
    expect(document.querySelector('.featured-halftone')).not.toBeInTheDocument()
  })
})
