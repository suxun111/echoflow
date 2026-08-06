import { describe, expect, it } from 'vitest'
import { loadServerEnv } from './index'

describe('server environment', () => {
  it('rejects unsafe production defaults', () => {
    expect(() => loadServerEnv({ NODE_ENV: 'production' })).toThrow()
  })

  it('provides development defaults outside production', () => {
    const env = loadServerEnv({ NODE_ENV: 'test' })
    expect(env.DATABASE_URL).toContain('postgresql://')
    expect(env.MEDIA_QUEUE_NAME).toBe('online-learning-media')
  })
})
