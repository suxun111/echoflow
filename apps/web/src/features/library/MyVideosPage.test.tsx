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
  afterEach(() => {
    cleanup()
    window.sessionStorage.clear()
  })

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

  it('shows persisted chunk counts and opens only the ACTIVE complete transcript', async () => {
    const ready = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 3, totalChunks: 3, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const transcript = {
      id: crypto.randomUUID(), mediaAssetId: ready.id, version: 1, language: 'en' as const,
      durationMs: ready.durationMs!, cueCount: 1, pipelineVersion: 'g3-transcript-v1', modelVersion: 'fake-moss-v1',
      publishedAt: new Date().toISOString(),
      cues: [{
        id: crypto.randomUUID(), order: 0, startMs: 500, endMs: 1_500, text: 'Hello podcast.',
        words: [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'podcast.', startMs: 1_000, endMs: 1_500 }],
      }],
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [ready] }
      if (path === `/media-assets/${ready.id}/transcript`) return transcript
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    await screen.findByText('完整英文逐词字幕已经原子发布')
    fireEvent.click(screen.getByRole('button', { name: '查看字幕' }))
    await screen.findByText('Hello podcast.')
    expect(screen.getByText('1 句 · MOSS fake-moss-v1')).toBeInTheDocument()
  })

  it('keeps the original playable on transcript failure and sends an idempotent retry', async () => {
    const failed = {
      ...asset,
      transcriptProcessing: {
        status: 'failed' as const, stage: 'transcribing' as const,
        completedChunks: 1, totalChunks: 2, errorCode: 'moss_timeout', updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/media-assets') return { items: [failed] }
      if (path.endsWith('/transcript/retry')) {
        expect(options?.method).toBe('POST')
        expect(new Headers(options?.headers).get('idempotency-key')).toMatch(/^web-/)
        return { accepted: true }
      }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    await screen.findByText('原片仍可播放 · moss_timeout')
    expect(screen.getByRole('button', { name: '播放原片' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试字幕' }))
    await waitFor(() => expect(api.fetchJson).toHaveBeenCalledWith(
      `/media-assets/${failed.id}/transcript/retry`, expect.objectContaining({ method: 'POST' }),
    ))
  })

  it('keeps a legacy over-sixty-minute original playable and hides its known-impossible transcript retry', async () => {
    const legacyOverLimit = {
      ...asset,
      durationMs: 60 * 60 * 1_000 + 1,
      transcriptProcessing: {
        status: 'failed' as const, stage: 'transcribing' as const,
        completedChunks: 1, totalChunks: 2, errorCode: 'media_duration_unsupported', updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [legacyOverLimit] }
      if (path === `/media-assets/${legacyOverLimit.id}/playback-url`) return { playbackUrl: 'https://storage.test/legacy.mp4?signature=1' }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    await screen.findByText(/超过 60 分钟的视频不能生成或重试字幕/)
    expect(screen.getByRole('button', { name: '播放原片' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试字幕' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '播放原片' }))
    await waitFor(() => expect(api.fetchJson).toHaveBeenCalledWith(
      `/media-assets/${legacyOverLimit.id}/playback-url`, { method: 'POST' },
    ))
  })

  it('keeps a legacy original playable but hides transcript retry when its duration is unknown', async () => {
    const legacyUnknownDuration = {
      ...asset,
      durationMs: null,
      transcriptProcessing: {
        status: 'failed' as const, stage: 'transcribing' as const,
        completedChunks: 1, totalChunks: 2, errorCode: 'moss_timeout', updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [legacyUnknownDuration] }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    await screen.findByText(/无法确认视频时长，不能生成或重试字幕/)
    expect(screen.getByRole('button', { name: '播放原片' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试字幕' })).not.toBeInTheDocument()
  })

  it('keeps a legacy over-sixty-minute published transcript readable', async () => {
    const legacyReady = {
      ...asset,
      durationMs: 60 * 60 * 1_000 + 1,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 2, totalChunks: 2, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [legacyReady] }
      if (path === `/media-assets/${legacyReady.id}/transcript`) return {
        id: crypto.randomUUID(), mediaAssetId: legacyReady.id, version: 1, language: 'en',
        durationMs: legacyReady.durationMs, cueCount: 1, pipelineVersion: 'legacy-g3', modelVersion: 'legacy-moss',
        publishedAt: new Date().toISOString(),
        cues: [{
          id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_000, text: 'Published before the limit changed.',
          words: [{ text: 'Published', startMs: 0, endMs: 500 }, { text: 'before', startMs: 500, endMs: 1_000 }],
        }],
      }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    await screen.findByText('完整英文逐词字幕已经原子发布')
    expect(screen.getByRole('button', { name: '播放原片' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看字幕' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试字幕' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看字幕' }))
    await screen.findByText('Published before the limit changed.')
  })

  it('reuses the same retry identity when the first response is lost', async () => {
    const failed = {
      ...asset,
      transcriptProcessing: {
        status: 'failed' as const, stage: 'transcribing' as const,
        completedChunks: 0, totalChunks: 1, errorCode: 'moss_unavailable', updatedAt: new Date().toISOString(),
      },
    }
    const retryKeys: string[] = []
    let attempts = 0
    const api = { fetchJson: vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/media-assets') return { items: [failed] }
      if (path.endsWith('/transcript/retry')) {
        retryKeys.push(new Headers(options?.headers).get('idempotency-key')!)
        attempts += 1
        if (attempts === 1) throw new Error('response lost')
        return { accepted: true }
      }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    const retry = await screen.findByRole('button', { name: '重试字幕' })
    fireEvent.click(retry)
    await screen.findByText('response lost')
    fireEvent.click(retry)
    await waitFor(() => expect(retryKeys).toHaveLength(2))
    expect(retryKeys[0]).toMatch(/^web-/)
    expect(retryKeys[1]).toBe(retryKeys[0])
  })
})
