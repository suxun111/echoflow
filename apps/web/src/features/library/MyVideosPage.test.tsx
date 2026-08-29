import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MediaAssetView } from '@online-learning/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../lib/apiClient'
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
    await screen.findByText('处理已结束；打开后会确认完整英文字幕是否可用。')
    fireEvent.click(screen.getByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('Hello podcast.')
    expect(screen.getByText('1 句 · 已确认完整英文字幕')).toBeInTheDocument()
    expect(screen.queryByText(/MOSS/)).not.toBeInTheDocument()
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
    await screen.findByText('字幕处理暂未完成，原片仍可播放，可稍后重试。')
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
    await screen.findByText(/超过当前 60 分钟上限/)
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
    await screen.findByText('处理已结束；打开后会确认完整英文字幕是否可用。')
    expect(screen.getByRole('button', { name: '播放原片' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '检查英文字幕' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试字幕' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('Published before the limit changed.')
  })

  it('treats a transcript 409 as an honest not-ready state instead of showing a partial transcript', async () => {
    const finished = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 2, totalChunks: 2, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [finished] }
      if (path === `/media-assets/${finished.id}/transcript`) {
        throw new ApiClientError(409, { code: 'transcript_not_ready', message: '完整英文字幕尚未准备好', requestId: 'test-request' })
      }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('完整英文字幕尚未准备好；不会显示部分字幕。')
    expect(screen.queryByText('Hello podcast.')).not.toBeInTheDocument()
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
    await screen.findByText('字幕暂时无法重新处理，请稍后再试。')
    fireEvent.click(retry)
    await waitFor(() => expect(retryKeys).toHaveLength(2))
    expect(retryKeys[0]).toMatch(/^web-/)
    expect(retryKeys[1]).toBe(retryKeys[0])
  })

  it('fails closed when an ACTIVE transcript belongs to a different media asset', async () => {
    const ready = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 1, totalChunks: 1, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [ready] }
      if (path === `/media-assets/${ready.id}/transcript`) return {
        id: crypto.randomUUID(), mediaAssetId: crypto.randomUUID(), version: 1, language: 'en', durationMs: ready.durationMs,
        cueCount: 1, pipelineVersion: 'g3-transcript-v1', modelVersion: 'untrusted-response', publishedAt: new Date().toISOString(),
        cues: [{ id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_000, text: 'Wrong asset subtitle.', words: [] }],
      }
      throw new Error(`unexpected ${path}`)
    }) }

    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('暂时无法读取完整英文字幕，请稍后重试。')
    expect(screen.queryByText('Wrong asset subtitle.')).not.toBeInTheDocument()
    expect(screen.queryByText(/untrusted-response/)).not.toBeInTheDocument()
  })

  it('fails closed when an ACTIVE transcript payload does not match its declared cue count', async () => {
    const ready = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 1, totalChunks: 1, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [ready] }
      if (path === `/media-assets/${ready.id}/transcript`) return {
        id: crypto.randomUUID(), mediaAssetId: ready.id, version: 1, language: 'en', durationMs: ready.durationMs,
        cueCount: 2, pipelineVersion: 'g3-transcript-v1', modelVersion: 'untrusted-response', publishedAt: new Date().toISOString(),
        cues: [{ id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_000, text: 'Incomplete response.', words: [] }],
      }
      throw new Error(`unexpected ${path}`)
    }) }

    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('暂时无法读取完整英文字幕，请稍后重试。')
    expect(screen.queryByText('Incomplete response.')).not.toBeInTheDocument()
  })

  it('renders a bounded read-only subtitle sample instead of a pseudo learning player', async () => {
    const ready = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 2, totalChunks: 2, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const cues = Array.from({ length: 13 }, (_, order) => ({
      id: crypto.randomUUID(), order, startMs: order * 1_000, endMs: order * 1_000 + 800,
      text: `Verified sentence ${order + 1}.`, words: [],
    }))
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [ready] }
      if (path === `/media-assets/${ready.id}/transcript`) return {
        id: crypto.randomUUID(), mediaAssetId: ready.id, version: 1, language: 'en', durationMs: ready.durationMs,
        cueCount: cues.length, pipelineVersion: 'g3-transcript-v1', modelVersion: 'private-model', publishedAt: new Date().toISOString(), cues,
      }
      throw new Error(`unexpected ${path}`)
    }) }

    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('Verified sentence 12.')
    expect(screen.getByRole('list', { name: '完整英文字幕核验样本' })).toBeInTheDocument()
    expect(screen.getByText(/显示前 12 句（共 13 句）/)).toBeInTheDocument()
    expect(screen.queryByText('Verified sentence 13.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /开始练习|下一句|循环/ })).not.toBeInTheDocument()
  })

  it('discards a late subtitle response after the user checks another media asset', async () => {
    const first = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 1, totalChunks: 1, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const second = { ...first, id: crypto.randomUUID(), title: 'Second long podcast', originalName: 'second.mp4' }
    let resolveFirst: (value: unknown) => void = () => undefined
    const firstResponse = new Promise<unknown>((resolve) => { resolveFirst = resolve })
    const api = { fetchJson: vi.fn((path: string) => {
      if (path === '/media-assets') return Promise.resolve({ items: [first, second] })
      if (path === `/media-assets/${first.id}/transcript`) return firstResponse
      if (path === `/media-assets/${second.id}/transcript`) return Promise.resolve({
        id: crypto.randomUUID(), mediaAssetId: second.id, version: 1, language: 'en', durationMs: second.durationMs,
        cueCount: 1, pipelineVersion: 'g3-transcript-v1', modelVersion: 'private-model', publishedAt: new Date().toISOString(),
        cues: [{ id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_000, text: 'Second verified subtitle.', words: [] }],
      })
      throw new Error(`unexpected ${path}`)
    }) }

    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    const buttons = await screen.findAllByRole('button', { name: '检查英文字幕' })
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    resolveFirst({
      id: crypto.randomUUID(), mediaAssetId: first.id, version: 1, language: 'en', durationMs: first.durationMs,
      cueCount: 1, pipelineVersion: 'g3-transcript-v1', modelVersion: 'private-model', publishedAt: new Date().toISOString(),
      cues: [{ id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_000, text: 'Stale first subtitle.', words: [] }],
    })

    await screen.findByText('Second verified subtitle.')
    expect(screen.queryByText('Stale first subtitle.')).not.toBeInTheDocument()
  })

  it('shows long-video handoff evidence as a stage, never as a percentage', async () => {
    const evidencing = {
      ...asset,
      transcriptProcessing: {
        status: 'processing' as const, stage: 'handoff_evidencing' as const,
        completedChunks: 2, totalChunks: 2, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [evidencing] }
      throw new Error(`unexpected ${path}`)
    }) }

    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    await screen.findByText('正在核验长视频字幕衔接')
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument()
  })

  it('closes the transcript sheet without closing an already open original player', async () => {
    const ready = {
      ...asset,
      transcriptProcessing: {
        status: 'succeeded' as const, stage: 'transcript_ready' as const,
        completedChunks: 1, totalChunks: 1, errorCode: null, updatedAt: new Date().toISOString(),
      },
    }
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [ready] }
      if (path === `/media-assets/${ready.id}/playback-url`) return { playbackUrl: 'https://storage.test/podcast.mp4?signature=1' }
      if (path === `/media-assets/${ready.id}/transcript`) return {
        id: crypto.randomUUID(), mediaAssetId: ready.id, version: 1, language: 'en', durationMs: ready.durationMs,
        cueCount: 1, pipelineVersion: 'g3-transcript-v1', modelVersion: 'private-model', publishedAt: new Date().toISOString(),
        cues: [{ id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_000, text: 'Verified subtitle.', words: [] }],
      }
      throw new Error(`unexpected ${path}`)
    }) }

    render(<MyVideosPage api={api as never} search="" onUpload={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '播放原片' }))
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '检查英文字幕' }))
    await screen.findByText('Verified subtitle.')

    fireEvent.click(screen.getByRole('button', { name: '关闭字幕' }))
    expect(screen.queryByText('Verified subtitle.')).not.toBeInTheDocument()
    expect(document.querySelector('video')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('video')).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: '播放原片' })).toHaveFocus())
  })
})
