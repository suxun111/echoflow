import { describe, expect, it } from 'vitest'
import { getYouTubeVideoId } from './youtube'

describe('getYouTubeVideoId', () => {
  it('accepts standard, short and shorts links', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=abc123&t=2')).toBe('abc123')
    expect(getYouTubeVideoId('https://youtu.be/abc123')).toBe('abc123')
    expect(getYouTubeVideoId('https://youtube.com/shorts/abc123')).toBe('abc123')
  })
  it('rejects non-YouTube links', () => expect(getYouTubeVideoId('https://example.com/watch?v=no')).toBeNull())
})
