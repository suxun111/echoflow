import { describe, expect, it } from 'vitest'
import { APP_TITLE, BRAND_NAME } from './brand'

describe('brand config', () => {
  it('keeps the public website name as online learning', () => {
    expect(BRAND_NAME).toBe('online learning')
    expect(APP_TITLE).toBe('online learning · 沉浸式英语影子跟读')
  })
})
