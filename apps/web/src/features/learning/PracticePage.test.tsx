import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { learningCues, libraryVideos } from '../../data/library'
import { getVocabulary } from '../../lib/vocabularyStore'
import { PracticePage } from './PracticePage'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('PracticePage word interactions', () => {
  it('renders every study mode with its required language content', () => {
    render(<PracticePage video={libraryVideos[0]} favorite={false} onBack={() => undefined} onFavorite={() => undefined} />)
    const currentCue = learningCues[1]
    const transcript = document.querySelector('.transcript-panel')!
    const workbench = document.querySelector('.sentence-workbench')!

    expect(workbench).toHaveTextContent(currentCue.english)
    expect(workbench).toHaveTextContent(currentCue.chinese)
    const renderedWords = Array.from(document.querySelectorAll('.focus-sentence .synced-word')).map((element) => element.textContent).filter(Boolean)
    expect(renderedWords).toHaveLength(currentCue.english.match(/\S+/g)?.length ?? 0)
    expect(renderedWords[0]).toBe('Today,')
    expect(renderedWords.at(-1)).toBe('town')
    expect(transcript).toHaveTextContent(learningCues[0].english)
    expect(transcript).toHaveTextContent(learningCues[0].chinese)

    fireEvent.click(screen.getByRole('button', { name: '英文' }))
    expect(workbench).toHaveTextContent(currentCue.english)
    expect(workbench).not.toHaveTextContent(currentCue.chinese)
    expect(transcript).toHaveTextContent(learningCues[0].english)
    expect(transcript).not.toHaveTextContent(learningCues[0].chinese)

    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(workbench).toHaveTextContent(currentCue.chinese)
    expect(workbench).not.toHaveTextContent(currentCue.english)
    expect(transcript).toHaveTextContent(learningCues[0].chinese)
    expect(transcript).not.toHaveTextContent(learningCues[0].english)
    expect(document.querySelector('.interactive-word')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查询 coastal town' })).not.toBeInTheDocument()
    expect(screen.queryByText('SLOW ENGLISH')).not.toBeInTheDocument()
    expect(document.querySelector('.video-caption')).toHaveTextContent(currentCue.chinese)

    fireEvent.click(screen.getByRole('button', { name: '单词' }))
    const wordList = screen.getByRole('list', { name: '本句逐词翻译' })
    expect(screen.getByText('本句逐词释义 · 10 项')).toBeInTheDocument()
    expect(within(wordList).getAllByRole('listitem')).toHaveLength(currentCue.wordTranslations.length)
    currentCue.wordTranslations.forEach((item) => {
      expect(within(wordList).getByText(item.word)).toBeInTheDocument()
      expect(within(wordList).getByText(item.translation)).toBeInTheDocument()
    })
    expect(screen.getByText('本句完整词组 · 2 项')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /taking you around/ })).toHaveTextContent('带你四处看看')
    expect(screen.getByRole('button', { name: /coastal town/ })).toHaveTextContent('海滨小镇')
    expect(screen.queryByText(currentCue.english)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一句' }))
    expect(screen.getByText('本句逐词释义 · 12 项')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /quiet place/ })).toHaveTextContent('安静的地方')

    fireEvent.click(screen.getByRole('button', { name: '双语' }))
    expect(screen.getByRole('button', { name: '跳转到第 1 句' })).toBeInTheDocument()
    expect(transcript).toHaveTextContent(learningCues[2].english)
    expect(transcript).toHaveTextContent(learningCues[2].chinese)
  })

  it('opens a local dictionary annotation and adds a word from the context menu', () => {
    render(<PracticePage video={libraryVideos[0]} favorite={false} onBack={() => undefined} onFavorite={() => undefined} />)

    const word = screen.getAllByRole('button', { name: '查询 coastal town' })[0]
    fireEvent.focus(word)

    expect(screen.getByRole('dialog', { name: 'coastal town 的词典注释' })).toHaveTextContent('海滨小镇')
    expect(screen.getByText('本句语境')).toBeInTheDocument()

    fireEvent.contextMenu(word, { clientX: 140, clientY: 120 })
    fireEvent.click(screen.getByRole('menuitem', { name: '加入生词本' }))

    expect(getVocabulary()).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('已加入生词本')
  })

  it('keeps playback controls compact but touchable and timestamps secondary', () => {
    render(<PracticePage video={libraryVideos[0]} favorite={false} onBack={() => undefined} onFavorite={() => undefined} />)

    const speed = screen.getByRole('combobox', { name: '播放倍速' })
    expect(speed).toHaveValue('1')
    fireEvent.change(speed, { target: { value: '1.5' } })
    expect(speed).toHaveValue('1.5')
    expect(document.querySelectorAll('.cue-time')).toHaveLength(learningCues.length)
    expect(document.querySelector('.cue-copy em')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '单词' }))
    const wordList = screen.getByRole('list', { name: '本句逐词翻译' })
    expect(within(wordList).getByText('Today')).toBeInTheDocument()
    expect(within(wordList).getAllByText('单词')).toHaveLength(learningCues[1].wordTranslations.length)
    expect(within(wordList).getByText('今天')).toBeInTheDocument()
    expect(screen.queryByText(/火山翻译/)).not.toBeInTheDocument()
  })

  it('renders phrase translations as dedicated study controls', () => {
    render(<PracticePage video={libraryVideos[0]} favorite={false} onBack={() => undefined} onFavorite={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: '单词' }))
    const phraseButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.vocab-phrase-item'))

    expect(phraseButtons).toHaveLength(2)
    expect(phraseButtons[0]).toHaveAccessibleName('查看词组 taking you around')
    expect(phraseButtons[0]).toHaveTextContent('带你四处看看')
    expect(phraseButtons[0].querySelector('.vocab-phrase-meta em')).toHaveTextContent('B1')
  })

  it('keeps the player timeline and captions on the same sentence clock', () => {
    vi.useFakeTimers()
    let activeUtterance: SpeechSynthesisUtterance | null = null
    const speechSynthesisMock = {
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
        activeUtterance = utterance
        utterance.onstart?.({} as SpeechSynthesisEvent)
      }),
    }

    vi.stubGlobal('speechSynthesis', speechSynthesisMock)
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''
      rate = 1
      pitch = 1
      onstart: ((event: SpeechSynthesisEvent) => void) | null = null
      onboundary: ((event: SpeechSynthesisEvent) => void) | null = null
      onend: ((event: SpeechSynthesisEvent) => void) | null = null
      onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null

      constructor(readonly text: string) {}
    })

    render(<PracticePage video={libraryVideos[0]} favorite={false} onBack={() => undefined} onFavorite={() => undefined} />)
    const player = document.querySelector('.learning-player')!
    const track = player.querySelector('.native-track i') as HTMLElement
    const initialTrackWidth = track.style.width

    fireEvent.click(screen.getByRole('button', { name: '播放句子朗读' }))
    act(() => {
      vi.advanceTimersByTime(1200)
    })

    expect(player).toHaveTextContent('0:06')
    expect(track.style.width).not.toBe(initialTrackWidth)
    expect(player.querySelector('.caption-word.is-current')).toBeInTheDocument()

    const boundaryIndex = learningCues[1].english.indexOf('am')
    act(() => {
      activeUtterance?.onboundary?.({ charIndex: boundaryIndex } as SpeechSynthesisEvent)
      vi.advanceTimersByTime(1200)
    })

    expect(player.querySelector('.caption-word.is-current')).toHaveTextContent('am')

    act(() => {
      activeUtterance?.onend?.({} as SpeechSynthesisEvent)
    })

    expect(player).toHaveTextContent('0:09')
    expect(player.querySelector('.caption-word.is-current')).not.toBeInTheDocument()
  })

  it('adds a word after a touch long press', () => {
    vi.useFakeTimers()
    render(<PracticePage video={libraryVideos[0]} favorite={false} onBack={() => undefined} onFavorite={() => undefined} />)

    const word = screen.getAllByRole('button', { name: '查询 coastal town' })[0]
    fireEvent.touchStart(word)
    act(() => {
      vi.advanceTimersByTime(550)
    })

    expect(getVocabulary()).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('已加入生词本')
  })
})
