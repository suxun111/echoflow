import type { ReactNode } from 'react'

export const designTokens = {
  color: { primary: '#7657e8', primaryDark: '#5e42d2', primarySoft: '#eeeafd', ink: '#252337', muted: '#89869b' },
  radius: { sm: 8, md: 12, lg: 18 },
} as const

export function StatusBadge({ children, tone = 'purple' }: { children: ReactNode; tone?: 'purple' | 'green' | 'orange' | 'red' }) {
  return <span className={`ol-status ol-status--${tone}`}>{children}</span>
}
