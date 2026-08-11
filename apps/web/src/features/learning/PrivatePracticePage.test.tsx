import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getVocabulary } from '../../lib/vocabularyStore'
import { PrivatePracticePage } from './PrivatePracticePage'

vi.mock('../../lib/privateCourseApi', () => ({
  getPrivateCourse: vi.fn(async () => ({
    id: 'private-course-1',
    title: 'Local MP4 lesson',
    creator: 'EchoFlow Local',
    coverUrl: null,
    playbackUrl: 'https://media.example.test/private-video.mp4',
    durationSeconds: 12,
    warnings: [],
    translation: { translatedCount: 1, totalCount: 1, missingCount: 0, status: 'completed', warnings: [] },
    cues: [
      { id: 'cue-1', order: 0, startMs: 0, endMs: 2500, english: 'Welcome to my coastal town.', chinese: '欢迎来到我的海滨小镇。', speaker: 'S01', keywords: ['coastal town'], reviewed: false },
    ],
  })),
}))

afterEach(() => {
  window.localStorage.clear()
})

describe('PrivatePracticePage', () => {
  it('renders an actual video element and keeps real cues available in the transcript', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)

    expect((await screen.findAllByText('Welcome to my coastal town.')).length).toBeGreaterThan(0)
    expect(document.querySelector('video')).toHaveAttribute('src', 'https://media.example.test/private-video.mp4')
    expect(screen.getAllByText('S01').length).toBeGreaterThan(0)
  })

  it('derives the current real cue vocabulary and keeps missing words explicit', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)
    await screen.findByText('Local MP4 lesson')

    fireEvent.click(screen.getAllByRole('button', { name: '单词' })[0])
    const vocabularyPanel = screen.getAllByTestId('private-vocabulary-panel')[0]
    expect(vocabularyPanel).toHaveTextContent('1/5 已收录')
    expect(vocabularyPanel).toHaveTextContent('本地词库暂未收录该单词')
    expect(vocabularyPanel).toHaveTextContent('coastal town')
    expect(screen.queryByText('暂未生成词汇')).not.toBeInTheDocument()
  })

  it('keeps Chinese self-test mode free of the English answer', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)
    await screen.findByText('Local MP4 lesson')

    fireEvent.click(screen.getAllByRole('button', { name: '中文' })[0])
    expect(document.body).toHaveTextContent('欢迎来到我的海滨小镇。')
    expect(document.body).not.toHaveTextContent('Welcome to my coastal town.')
    expect(document.querySelector('.interactive-word')).not.toBeInTheDocument()
  })

  it('stores a real private course source when adding a cue word', async () => {
    render(<PrivatePracticePage courseId="private-course-1" onBack={() => undefined}/>)
    await screen.findByText('Local MP4 lesson')

    fireEvent.contextMenu(screen.getByRole('button', { name: '查询 Welcome' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '加入生词本' }))

    expect(getVocabulary()[0]).toMatchObject({
      normalizedWord: 'welcome',
      lessonId: 'private-course-1',
      cueId: 'cue-1',
      contextEnglish: 'Welcome to my coastal town.',
    })
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
