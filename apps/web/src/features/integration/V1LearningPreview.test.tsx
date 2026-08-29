import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ActiveTranscriptView, MediaAssetView } from '@online-learning/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { V1LearningPreview } from './V1LearningPreview'

const asset: MediaAssetView = {
  id: '0f6bc7cc-a705-41a2-8a8a-b1d624520cca',
  uploadSessionId: null,
  title: 'Private English podcast',
  originalName: 'podcast.mp4',
  status: 'playable',
  durationMs: 600_000,
  processingStage: 'playback_ready',
  errorCode: null,
  transcriptProcessing: { status: 'succeeded', stage: 'transcript_ready', completedChunks: 2, totalChunks: 2, errorCode: null, updatedAt: new Date().toISOString() },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const activeTranscript: ActiveTranscriptView = {
  id: 'd6f304d7-ab19-4bd5-9a2d-3333ab2c98ad',
  mediaAssetId: asset.id,
  version: 3,
  language: 'en',
  durationMs: 600_000,
  cueCount: 2,
  pipelineVersion: 'g3-transcript-v1',
  modelVersion: 'private-model-version',
  publishedAt: new Date().toISOString(),
  cues: [
    {
      id: '83185fae-222a-4f4c-ae9a-39186e0ea2ea', order: 0, startMs: 0, endMs: 1_500,
      text: 'First verified sentence.',
      words: [
        { text: 'First', startMs: 0, endMs: 450 },
        { text: 'verified', startMs: 500, endMs: 1_000 },
        { text: 'sentence.', startMs: 1_050, endMs: 1_500 },
      ],
    },
    { id: 'd12d3752-fe98-4b05-bf35-817205d64089', order: 1, startMs: 300_000, endMs: 301_500, text: 'Second verified sentence.', words: [] },
  ],
}

function renderPreview(overrides: Partial<Parameters<typeof V1LearningPreview>[0]> = {}) {
  return render(<V1LearningPreview
    asset={asset}
    playback={{ kind: 'ready', assetId: asset.id, url: 'https://storage.test/podcast.mp4?signature=1' }}
    transcript={{ kind: 'ready', assetId: asset.id, value: activeTranscript }}
    onVerifyPlayback={vi.fn()}
    onVerifyTranscript={vi.fn()}
    {...overrides}
  />)
}

describe('V1LearningPreview', () => {
  afterEach(cleanup)

  it('keeps every learning control locked without the unique ACTIVE transcript', () => {
    renderPreview({ transcript: { kind: 'not-ready', assetId: asset.id } })

    expect(screen.getByRole('button', { name: /观看/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /跟读/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /精听/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /播放/ })).toBeDisabled()
    expect(screen.getByText('当前没有可读取的完整英文字幕；部分结果不会进入学习界面。')).toBeInTheDocument()
    expect(screen.queryByLabelText(`${asset.title} V1 学习界面原片`)).not.toBeInTheDocument()
    expect(screen.queryByText('First verified sentence.')).not.toBeInTheDocument()
  })

  it('uses the real video clock to select cues and supports deterministic cue seeking', () => {
    renderPreview()
    const video = screen.getByLabelText(`${asset.title} V1 学习界面原片`) as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })

    video.currentTime = 300
    fireEvent.timeUpdate(video)
    expect(screen.getByRole('button', { name: /Second verified sentence/ }).closest('li')).toHaveClass('current')

    fireEvent.click(screen.getByRole('button', { name: /First verified sentence/ }))
    expect(video.currentTime).toBe(0)
  })

  it('implements the V1-compatible watch, shadow and listen semantics without bilingual or speaker claims', async () => {
    renderPreview()
    const video = screen.getByLabelText(`${asset.title} V1 学习界面原片`) as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0.6 })
    fireEvent.timeUpdate(video)

    fireEvent.click(screen.getByRole('button', { name: /跟读/ }))
    expect(screen.getByText('按原片节奏开口模仿；本阶段不保存录音或学习进度。')).toBeInTheDocument()
    expect(document.querySelector('.v1-focus-sentence .spoken')).toHaveTextContent('First')

    fireEvent.click(screen.getByRole('button', { name: /精听/ }))
    expect(screen.getByText('精听模式：字幕已隐藏')).toBeInTheDocument()
    expect(screen.getByText('先听，再切回“观看”核对')).toBeInTheDocument()
    expect(screen.queryByText('Second verified sentence.')).not.toBeInTheDocument()
    expect(screen.queryByText(/中文|说话人|双语/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /观看/ }))
    fireEvent.click(screen.getByRole('button', { name: /1x\s*倍速/ }))
    await waitFor(() => expect(video.playbackRate).toBe(1.25))
  })

  it('loops only the selected real cue', () => {
    renderPreview()
    const video = screen.getByLabelText(`${asset.title} V1 学习界面原片`) as HTMLVideoElement
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    fireEvent.click(screen.getByRole('button', { name: /单句循环/ }))

    video.currentTime = 1.6
    fireEvent.timeUpdate(video)
    expect(video.currentTime).toBe(0)
    expect(screen.getByRole('button', { name: /单句循环/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps long ACTIVE transcripts inside a bounded 80-cue render window', () => {
    const cues = Array.from({ length: 120 }, (_, index) => ({
      id: `window-cue-${index}`,
      order: index,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: `Window cue ${index}.`,
      words: [],
    }))

    renderPreview({
      transcript: {
        kind: 'ready',
        assetId: asset.id,
        value: { ...activeTranscript, cueCount: cues.length, cues },
      },
    })

    expect(document.querySelectorAll('.v1-cue-list button')).toHaveLength(80)
    expect(screen.getByText('Window cue 79.')).toBeInTheDocument()
    expect(screen.queryByText('Window cue 80.')).not.toBeInTheDocument()
  })

  it('does not expose model identity or persist progress in the preview surface', () => {
    renderPreview()
    expect(screen.queryByText('private-model-version')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /录音|保存进度/ })).not.toBeInTheDocument()
    expect(screen.getByText(/录音持久化、学习进度和正式入口仍属于 G4/)).toBeInTheDocument()
  })
})
