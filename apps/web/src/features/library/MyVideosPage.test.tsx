import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MediaAssetView } from '@online-learning/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MyVideosPage } from './MyVideosPage'

const asset: MediaAssetView = {
  id: '85691c0b-0a44-454f-bf2f-7ebfac78ce17', uploadSessionId: crypto.randomUUID(),
  title: 'Long podcast', originalName: 'podcast.mp4', status: 'playable', durationMs: 3_600_000,
  processingStage: 'playback_ready', errorCode: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}

describe('G2 signed playback recovery', () => {
  afterEach(() => cleanup())

  it('refreshes an expired playback URL once and restores the previous currentTime', async () => {
    let signed = 0
    const api = {
      fetchJson: vi.fn(async (path: string) => {
        if (path === '/media-assets') return { items: [asset] }
        if (path === `/media-assets/${asset.id}/playback-url`) {
          signed += 1
          return { playbackUrl: `https://storage.test/podcast.mp4?signature=${signed}` }
        }
        throw new Error(`unexpected ${path}`)
      }),
    }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '播放原片' }))
    const video = await waitFor(() => {
      const element = document.querySelector('video')
      expect(element).not.toBeNull()
      return element as HTMLVideoElement
    })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 37.25 })
    fireEvent.error(video)
    await waitFor(() => expect(signed).toBe(2))
    expect(video.src).toContain('signature=2')

    video.currentTime = 0
    fireEvent.loadedMetadata(video)
    expect(video.currentTime).toBe(37.25)
    fireEvent.error(video)
    await screen.findByText('播放地址刷新后仍不可用，请稍后重试')
    expect(signed).toBe(2)
  })
})
