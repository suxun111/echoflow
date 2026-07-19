import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('EchoFlow visual theme', () => {
  it('renders restrained pop-art hooks on the home page', () => {
    render(<App />)

    expect(document.querySelector('.library-page')).toHaveAttribute('data-visual-theme', 'restrained-pop')
    expect(document.querySelector('.featured-halftone')).toBeInTheDocument()
  })
})
