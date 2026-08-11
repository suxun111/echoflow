import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PrivatePracticePage } from './PrivatePracticePage'

vi.mock('../../lib/privateCourseApi', () => ({
  getPrivateCourse: vi.fn(async () => ({
    id: 'private-course-1',
    title: 'Local MP4 lesson',
    creator: 'EchoFlow Local',
    coverUrl: null,
    playbackUrl: 'https://media.example.test/private-video.mp4',
     durationSeconds: 12,
     translation: { translatedCount: 1, totalCount: 1, missingCount: 0, status: 'completed', warnings: [] },
     vocabularyTranslation: { translatedCount: 2, totalCount: 2, missingCount: 0, status: 'completed', warnings: [] },
     vocabulary: [
       { id: 'term-1', lessonId: 'private-course-1', sourceCueId: 'cue-1', word: 'timeline', normalizedWord: 'timeline', termType: 'WORD', sourceSentence: 'Hello from the real timeline.', translation: '时间轴', translationSource: 'VOLCENGINE', translationStatus: 'TRANSLATED', translationErrorCode: null, translatedAt: '2026-08-01T00:00:00.000Z' },
       { id: 'term-2', lessonId: 'private-course-1', sourceCueId: 'cue-1', word: 'real timeline', normalizedWord: 'real timeline', termType: 'PHRASE', sourceSentence: 'Hello from the real timeline.', translation: '真实时间轴', translationSource: 'VOLCENGINE', translationStatus: 'TRANSLATED', translationErrorCode: null, translatedAt: '2026-08-01T00:00:00.000Z' },
     ],
     warnings: [],
    cues: [
      { id: 'cue-1', order: 0, startMs: 0, endMs: 2500, english: 'Hello from the real timeline.', chinese: '来自真实时间轴的问候。', speaker: 'S01', keywords: [], reviewed: false },
    ],
  })),
}))

describe('PrivatePracticePage', () => {
  it('renders an actual video element and keeps real cues available in the transcript', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)

    expect((await screen.findAllByText('Hello from the real timeline.')).length).toBeGreaterThan(0)
    expect(document.querySelector('video')).toHaveAttribute('src', 'https://media.example.test/private-video.mp4')
    expect(screen.getAllByText('S01').length).toBeGreaterThan(0)
  })

  it('shows real API vocabulary instead of a fabricated word list', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)
    await screen.findByText('Local MP4 lesson')

    fireEvent.click(screen.getAllByRole('button', { name: '单词' })[0])
    expect(screen.getAllByText('时间轴 · 火山翻译').length).toBeGreaterThan(0)
  })

  it('renders real word and phrase translations from the course API', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)
    await screen.findByText('Local MP4 lesson')
    fireEvent.click(screen.getAllByRole('button', { name: '单词' })[0])
    expect(screen.getAllByText('timeline').length).toBeGreaterThan(0)
    expect(screen.getAllByText('real timeline').length).toBeGreaterThan(0)
    expect(screen.getAllByText('词组 / 短语').length).toBeGreaterThan(0)
  })

  it('loops the active cue before its timeline falls outside that cue', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)
    await screen.findByText('Local MP4 lesson')

    const video = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, value: 12 })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 2.5 })
    Object.defineProperty(video, 'play', { configurable: true, value: vi.fn().mockResolvedValue(undefined) })

    fireEvent.click(screen.getByRole('button', { name: '单句循环' }))
    fireEvent.timeUpdate(video)

    expect(video.currentTime).toBe(0)
  })
})
