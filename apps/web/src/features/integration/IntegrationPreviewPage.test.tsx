import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ActiveTranscriptView, MediaAssetView } from '@online-learning/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../lib/apiClient'
import { IntegrationPreviewPage } from './IntegrationPreviewPage'

const asset: MediaAssetView = {
  id: '0f6bc7cc-a705-41a2-8a8a-b1d624520cca', uploadSessionId: null,
  title: 'Private English podcast', originalName: 'podcast.mp4', status: 'playable', durationMs: 600_000,
  processingStage: 'playback_ready', errorCode: null,
  transcriptProcessing: { status: 'succeeded', stage: 'transcript_ready', completedChunks: 2, totalChunks: 2, errorCode: null, updatedAt: new Date().toISOString() },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}

function transcript(): ActiveTranscriptView {
  return {
    id: crypto.randomUUID(), mediaAssetId: asset.id, version: 1, language: 'en', durationMs: 600_000,
    cueCount: 2, pipelineVersion: 'g3-transcript-v1', modelVersion: 'private-model-version', publishedAt: new Date().toISOString(),
    cues: [
      { id: crypto.randomUUID(), order: 0, startMs: 0, endMs: 1_500, text: 'First verified sentence.', words: [] },
      { id: crypto.randomUUID(), order: 1, startMs: 300_000, endMs: 301_500, text: 'Second verified sentence.', words: [] },
    ],
  }
}

describe('IntegrationPreviewPage', () => {
  afterEach(cleanup)

  it('does not display partial subtitle content when the ACTIVE transcript endpoint returns 409', async () => {
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [asset] }
      if (path.endsWith('/transcript')) throw new ApiClientError(409, { code: 'transcript_not_ready', message: '完整英文字幕尚未准备好', requestId: 'preview-test' })
      throw new Error(`unexpected ${path}`)
    }) }
    render(<IntegrationPreviewPage api={api as never} onReturnToLibrary={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '检查完整英文字幕' }))
    await screen.findByText('完整英文字幕尚未准备好；不会显示部分字幕。')
    expect(screen.queryByText('First verified sentence.')).not.toBeInTheDocument()
  })

  it('renders only a bounded read-only ACTIVE cue sample and never exposes the model version', async () => {
    const active = transcript()
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [asset] }
      if (path.endsWith('/transcript')) return active
      throw new Error(`unexpected ${path}`)
    }) }
    render(<IntegrationPreviewPage api={api as never} onReturnToLibrary={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '检查完整英文字幕' }))
    await screen.findByText('First verified sentence.')
    expect(screen.getByText('已确认完整英文字幕')).toBeInTheDocument()
    expect(screen.getByText('Second verified sentence.')).toBeInTheDocument()
    expect(screen.queryByText('private-model-version')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下一段' })).not.toBeInTheDocument()
  })

  it('requests a signed playback URL only after the user starts that verification', async () => {
    const api = { fetchJson: vi.fn(async (path: string) => {
      if (path === '/media-assets') return { items: [asset] }
      if (path.endsWith('/playback-url')) return { mediaAssetId: asset.id, playbackUrl: 'https://storage.test/podcast.mp4?signature=1', expiresAt: new Date(Date.now() + 60_000).toISOString() }
      throw new Error(`unexpected ${path}`)
    }) }
    render(<IntegrationPreviewPage api={api as never} onReturnToLibrary={vi.fn()}/>)
    const playbackButton = await screen.findByRole('button', { name: '验证原片播放' })
    expect(api.fetchJson).not.toHaveBeenCalledWith(`/media-assets/${asset.id}/playback-url`, expect.anything())
    fireEvent.click(playbackButton)
    await waitFor(() => expect(api.fetchJson).toHaveBeenCalledWith(
      `/media-assets/${asset.id}/playback-url`, { method: 'POST' },
    ))
  })

  it('discards A responses after the user switches to B', async () => {
    const secondAsset: MediaAssetView = { ...asset, id: crypto.randomUUID(), title: 'A different private recording', originalName: 'second.mp4' }
    let resolvePlayback: (value: unknown) => void = () => undefined
    let resolveTranscript: (value: unknown) => void = () => undefined
    const playbackResponse = new Promise<unknown>((resolve) => { resolvePlayback = resolve })
    const transcriptResponse = new Promise<unknown>((resolve) => { resolveTranscript = resolve })
    const api = { fetchJson: vi.fn((path: string) => {
      if (path === '/media-assets') return Promise.resolve({ items: [asset, secondAsset] })
      if (path === `/media-assets/${asset.id}/playback-url`) return playbackResponse
      if (path === `/media-assets/${asset.id}/transcript`) return transcriptResponse
      throw new Error(`unexpected ${path}`)
    }) }

    render(<IntegrationPreviewPage api={api as never} onReturnToLibrary={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name: '验证原片播放' }))
    fireEvent.click(screen.getByRole('button', { name: '检查完整英文字幕' }))
    fireEvent.click(screen.getByRole('button', { name: /A different private recording/ }))
    resolvePlayback({ mediaAssetId: asset.id, playbackUrl: 'https://storage.test/podcast.mp4?signature=1', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    resolveTranscript(transcript())

    await waitFor(() => expect(screen.getByRole('heading', { name: 'A different private recording' })).toBeInTheDocument())
    expect(screen.queryByLabelText(`${asset.title} 原片播放`)).not.toBeInTheDocument()
    expect(screen.queryByText('First verified sentence.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '验证原片播放' })).toBeInTheDocument()
  })
})
