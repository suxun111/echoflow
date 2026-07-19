import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BRAND_NAME } from '../../config/brand'
import { AccountPage } from './AccountPage'

describe('AccountPage brand', () => {
  it('uses the configured public website name', () => {
    render(<AccountPage view="settings" />)

    expect(screen.getByText(`YOUR ${BRAND_NAME.toUpperCase()}`)).toBeInTheDocument()
    expect(screen.queryByText('YOUR ECHOFLOW')).not.toBeInTheDocument()
  })
})
