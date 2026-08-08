import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { ContextMenu } from '../../components/ContextMenu'
import { DictionaryPopover, type PopoverPosition } from '../../components/DictionaryPopover'
import { Icon } from '../../components/Icon'
import {
  getVocabularyEntriesForHighlights,
  lookupDictionaryEntry,
  normalizeVocabularyTerm,
  segmentCueText,
} from '../../data/dictionary'
import { learningCues, type LearningCue, type LibraryVideo } from '../../data/library'
import { useRecorder } from '../../hooks/useRecorder'
import {
  addVocabularyWord,
  isInVocabulary,
} from '../../lib/vocabularyStore'

type PracticePageProps = {
  video: LibraryVideo
  onBack: () => void
  favorite: boolean
  onFavorite: () => void
}

type ActiveWord = {
  word: string
  normalizedWord: string
  cue: LearningCue
  position: PopoverPosition
}

type WordMenu = ActiveWord & {
  x: number
  y: number
}

type InteractiveSentenceProps = {
  text: string
  cue: LearningCue
  activeWordIndex?: number | null
  onOpen: (element: HTMLElement, word: string, cue: LearningCue) => void
  onScheduleClose: () => void
  onContextMenu: (event: MouseEvent<HTMLSpanElement>, word: string, cue: LearningCue) => void
  onLongPress: (element: HTMLElement, word: string, cue: LearningCue) => void
}

function getSentenceWords(text: string) {
  const words: Array<{ value: string; start: number }> = []
  const pattern = /\S+/g
  let match = pattern.exec(text)
  while (match) {
    words.push({ value: match[0], start: match.index })
    match = pattern.exec(text)
  }
  return words
}

function formatCueTime(value: number) {
  return '0:' + value.toString().padStart(2, '0')
}

function cueTimestamp(cue: LearningCue) {
  return formatCueTime(cue.start) + ' - ' + formatCueTime(cue.end)
}

function InteractiveSentence({
  text,
  cue,
  activeWordIndex = null,
  onOpen,
  onScheduleClose,
  onContextMenu,
  onLongPress,
}: InteractiveSentenceProps) {
  const longPressTimer = useRef<number | null>(null)
  const longPressHandled = useRef(false)
  let wordIndex = 0

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const startLongPress = (element: HTMLElement, word: string) => {
    clearLongPress()
    longPressHandled.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressHandled.current = true
      longPressTimer.current = null
      onLongPress(element, word, cue)
    }, 550)
  }

  useEffect(() => clearLongPress, [])

  const openWord = (event: MouseEvent<HTMLSpanElement> | FocusEvent<HTMLSpanElement>, word: string) => {
    onOpen(event.currentTarget, word, cue)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>, word: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onOpen(event.currentTarget, word, cue)
  }

  const renderSegment = (value: string, keyPrefix: string) => value.split(/(\s+)/).map((part, partIndex) => {
    if (!part || /^\s+$/.test(part) || !/[A-Za-z0-9]/.test(part)) return part
    const currentWordIndex = wordIndex
    wordIndex += 1
    return <span
      key={keyPrefix + '-word-' + partIndex}
      className={'synced-word' + (currentWordIndex === activeWordIndex ? ' is-current' : '')}
    >
      {part}
    </span>
  })

  return <>
    {segmentCueText(text, cue.highlight).map((segment, index) => {
      if (!segment.entry) return <span key={'plain-' + index}>{renderSegment(segment.value, 'plain-' + index)}</span>

      const normalizedWord = normalizeVocabularyTerm(segment.value)
      return (
        <span
          key={segment.entry.id + '-' + index}
          className="interactive-word is-highlighted"
          role="button"
          tabIndex={0}
          data-word={segment.value}
          data-normalized-word={normalizedWord}
          data-cue-id={cue.id}
          aria-label={'查询 ' + segment.value}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') openWord(event, segment.value)
          }}
          onPointerLeave={() => {
            clearLongPress()
            onScheduleClose()
          }}
          onFocus={(event) => openWord(event, segment.value)}
          onBlur={onScheduleClose}
          onClick={(event) => {
            event.stopPropagation()
            if (longPressHandled.current) {
              longPressHandled.current = false
              return
            }
            openWord(event, segment.value)
          }}
          onKeyDown={(event) => handleKeyDown(event, segment.value)}
          onContextMenu={(event) => onContextMenu(event, segment.value, cue)}
          onPointerDown={(event: PointerEvent<HTMLSpanElement>) => {
            if (event.pointerType !== 'touch') return
            startLongPress(event.currentTarget, segment.value)
          }}
          onPointerMove={clearLongPress}
          onPointerUp={clearLongPress}
          onPointerCancel={clearLongPress}
          onTouchStart={(event) => startLongPress(event.currentTarget, segment.value)}
          onTouchMove={clearLongPress}
          onTouchEnd={clearLongPress}
          onTouchCancel={clearLongPress}
        >
          {renderSegment(segment.value, 'entry-' + segment.entry.id + '-' + index)}
        </span>
      )
    })}
  </>
}

function PlayerCaption({ text, activeWordIndex = null }: { text: string; activeWordIndex?: number | null }) {
  let wordIndex = 0

  return <>
    {text.split(/(\s+)/).map((part, partIndex) => {
      if (!part || /^\s+$/.test(part)) return part
      const currentWordIndex = wordIndex
      wordIndex += 1
      return <span
        key={'caption-word-' + partIndex}
        className={'caption-word' + (currentWordIndex === activeWordIndex ? ' is-current' : '')}
      >
        {part}
      </span>
    })}
  </>
}

export function PracticePage({ video, onBack, favorite, onFavorite }: PracticePageProps) {
  const [current, setCurrent] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tab, setTab] = useState<'双语' | '英文' | '中文' | '单词'>('双语')
  const [hiddenVideo, setHiddenVideo] = useState(false)
  const [dictation, setDictation] = useState(false)
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null)
  const [wordMenu, setWordMenu] = useState<WordMenu | null>(null)
  const [vocabularyNotice, setVocabularyNotice] = useState<string | null>(null)
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null)
  const [sentenceProgress, setSentenceProgress] = useState(0)
  const closeTimer = useRef<number | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const activeWordRef = useRef<number | null>(null)
  const speechRef = useRef<{
    utterance: SpeechSynthesisUtterance | null
    fallbackTimer: number | null
    isPaused: boolean
    pausedAt: number | null
    pausedDuration: number
    hasBoundaryEvents: boolean
  }>({ utterance: null, fallbackTimer: null, isPaused: false, pausedAt: null, pausedDuration: 0, hasBoundaryEvents: false })
  const cue = learningCues[current]
  const phraseVocabulary = useMemo(
    () => getVocabularyEntriesForHighlights(cue.highlight).filter((entry) => entry.word.includes(' ')),
    [cue],
  )
  const showEnglish = tab === '双语' || tab === '英文'
  const showChinese = tab === '双语' || tab === '中文'
  const chineseSelfCheck = tab === '中文'
  const showDictation = dictation && !chineseSelfCheck && tab !== '单词'
  const playerCaption = showEnglish ? cue.english : chineseSelfCheck ? cue.chinese : null
  const timelineEnd = learningCues[learningCues.length - 1]?.end ?? cue.end
  const playerTime = cue.start + (cue.end - cue.start) * sentenceProgress
  const playerTrackWidth = Math.min(100, playerTime / timelineEnd * 100)

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const scheduleWordClose = useCallback(() => {
    clearCloseTimer()
    closeTimer.current = window.setTimeout(() => setActiveWord(null), 160)
  }, [clearCloseTimer])

  const openWord = useCallback((element: HTMLElement, word: string, wordCue: LearningCue) => {
    clearCloseTimer()
    const rect = element.getBoundingClientRect()
    setActiveWord({
      word,
      normalizedWord: normalizeVocabularyTerm(word),
      cue: wordCue,
      position: { top: rect.top, left: rect.left, bottom: rect.bottom },
    })
  }, [clearCloseTimer])

  const showVocabularyNotice = useCallback((message: string) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    setVocabularyNotice(message)
    noticeTimer.current = window.setTimeout(() => setVocabularyNotice(null), 2400)
  }, [])

  const addWordToVocabulary = useCallback((wordState: ActiveWord) => {
    const dictionaryEntry = lookupDictionaryEntry(wordState.word)
    const result = addVocabularyWord({
      word: wordState.word,
      meaning: dictionaryEntry?.meaning ?? '本地词库暂未收录释义',
      level: dictionaryEntry?.level ?? '未分级',
      exampleEnglish: dictionaryEntry?.exampleEnglish ?? wordState.cue.english,
      exampleChinese: dictionaryEntry?.exampleChinese ?? wordState.cue.chinese,
      contextEnglish: wordState.cue.english,
      contextChinese: wordState.cue.chinese,
      lessonId: video.id,
      lessonTitle: video.title,
      cueId: wordState.cue.id,
      timestamp: cueTimestamp(wordState.cue),
    })

    showVocabularyNotice(result.added
      ? '“' + wordState.word + '” 已加入生词本'
      : '“' + wordState.word + '” 已在生词本中')
    setWordMenu(null)
  }, [showVocabularyNotice, video.id, video.title])

  const openWordMenu = useCallback((
    event: MouseEvent<HTMLSpanElement>,
    word: string,
    wordCue: LearningCue,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    clearCloseTimer()
    const rect = event.currentTarget.getBoundingClientRect()
    setWordMenu({
      word,
      normalizedWord: normalizeVocabularyTerm(word),
      cue: wordCue,
      position: { top: rect.top, left: rect.left, bottom: rect.bottom },
      x: event.clientX,
      y: event.clientY,
    })
  }, [clearCloseTimer])

  const handleLongPress = useCallback((element: HTMLElement, word: string, wordCue: LearningCue) => {
    const rect = element.getBoundingClientRect()
    addWordToVocabulary({
      word,
      normalizedWord: normalizeVocabularyTerm(word),
      cue: wordCue,
      position: { top: rect.top, left: rect.left, bottom: rect.bottom },
    })
  }, [addWordToVocabulary])

  const handleRecordingComplete = useCallback(async (blob: Blob) => {
    setRecordingUrl(URL.createObjectURL(blob))
  }, [])
  const recorder = useRecorder(handleRecordingComplete)
  const go = (index: number) => setCurrent(Math.min(Math.max(index, 0), learningCues.length - 1))

  const clearSpeechTimer = useCallback(() => {
    if (speechRef.current.fallbackTimer !== null) {
      window.clearInterval(speechRef.current.fallbackTimer)
      speechRef.current.fallbackTimer = null
    }
  }, [])

  const updateActiveWord = useCallback((index: number | null, source: SpeechSynthesisUtterance | null = null) => {
    if (source && (speechRef.current.utterance !== source || speechRef.current.isPaused)) return
    setActiveWordIndex((current) => {
      if (source && (speechRef.current.utterance !== source || speechRef.current.isPaused)) return current
      activeWordRef.current = index
      return index
    })
  }, [])

  const updateSentenceProgress = useCallback((progress: number, source: SpeechSynthesisUtterance | null = null) => {
    if (source && (speechRef.current.utterance !== source || speechRef.current.isPaused)) return
    setSentenceProgress((current) => {
      if (source && (speechRef.current.utterance !== source || speechRef.current.isPaused)) return current
      return Math.min(1, Math.max(0, progress))
    })
  }, [])

  const stopSpeech = useCallback(() => {
    clearSpeechTimer()
    speechRef.current.utterance = null
    speechRef.current.isPaused = false
    speechRef.current.pausedAt = null
    speechRef.current.pausedDuration = 0
    speechRef.current.hasBoundaryEvents = false
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setPlaying(false)
    updateActiveWord(null)
    updateSentenceProgress(0)
  }, [clearSpeechTimer, updateActiveWord, updateSentenceProgress])

  const toggleSpeechPlayback = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      setVocabularyNotice('当前浏览器不支持句子朗读')
      return
    }

    const synthesis = window.speechSynthesis
    if (speechRef.current.utterance) {
      if (speechRef.current.isPaused) {
        if (speechRef.current.pausedAt !== null) {
          speechRef.current.pausedDuration += Date.now() - speechRef.current.pausedAt
          speechRef.current.pausedAt = null
        }
        synthesis.resume()
        speechRef.current.isPaused = false
        setPlaying(true)
      } else {
        synthesis.pause()
        speechRef.current.isPaused = true
        speechRef.current.pausedAt = Date.now()
        updateActiveWord(null)
        setPlaying(false)
      }
      return
    }

    clearSpeechTimer()
    synthesis.cancel()
    const words = getSentenceWords(cue.english)
    const utterance = new SpeechSynthesisUtterance(cue.english)
    utterance.lang = 'en-GB'
    utterance.rate = speed
    utterance.pitch = 1
    let startedAt = 0
    const fallbackDuration = Math.max(cue.end - cue.start, words.length * 0.28) / speed

    const finish = () => {
      if (speechRef.current.utterance !== utterance) return
      updateSentenceProgress(1)
      clearSpeechTimer()
      speechRef.current.utterance = null
      speechRef.current.isPaused = false
      speechRef.current.pausedAt = null
      speechRef.current.pausedDuration = 0
      speechRef.current.hasBoundaryEvents = false
      setPlaying(false)
      updateActiveWord(null)
    }

    utterance.onstart = () => {
      startedAt = Date.now()
      speechRef.current.isPaused = false
      speechRef.current.pausedAt = null
      speechRef.current.pausedDuration = 0
      speechRef.current.hasBoundaryEvents = false
      setPlaying(true)
      updateActiveWord(words.length > 0 ? 0 : null, utterance)
      updateSentenceProgress(0, utterance)
    }
    utterance.onboundary = (event) => {
      if (speechRef.current.utterance !== utterance || speechRef.current.isPaused) return
      speechRef.current.hasBoundaryEvents = true
      const boundaryIndex = words.reduce((index, word, wordIndex) => (
        event.charIndex >= word.start ? wordIndex : index
      ), -1)
      if (boundaryIndex >= 0) {
        updateActiveWord(boundaryIndex, utterance)
        updateSentenceProgress(Math.min(.98, (boundaryIndex + .5) / Math.max(words.length, 1)), utterance)
      }
    }
    utterance.onend = finish
    utterance.onerror = finish
    updateActiveWord(null)
    updateSentenceProgress(0)
    speechRef.current.utterance = utterance
    speechRef.current.hasBoundaryEvents = false
    speechRef.current.fallbackTimer = window.setInterval(() => {
      if (speechRef.current.utterance !== utterance || speechRef.current.isPaused || startedAt === 0 || speechRef.current.hasBoundaryEvents) return
      const elapsed = Date.now() - startedAt - speechRef.current.pausedDuration
      const progress = Math.min(0.999, elapsed / 1000 / fallbackDuration)
      updateActiveWord(words.length > 0 ? Math.floor(progress * words.length) : null, utterance)
      updateSentenceProgress(progress, utterance)
    }, 60)
    synthesis.speak(utterance)
  }, [clearSpeechTimer, cue.english, cue.end, cue.start, speed, updateActiveWord, updateSentenceProgress])

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
  }, [recordingUrl])

  useEffect(() => () => stopSpeech(), [stopSpeech])

  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Element
      if (!target.closest('.interactive-word') && !target.closest('.dictionary-popover')) {
        setActiveWord(null)
      }
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveWord(null)
        setWordMenu(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  useEffect(() => () => {
    clearCloseTimer()
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
  }, [clearCloseTimer])

  useEffect(() => {
    stopSpeech()
    setActiveWord(null)
    setWordMenu(null)
  }, [current, stopSpeech])

  const openVocabularyItem = (element: HTMLElement, word: string, wordCue: LearningCue) => {
    openWord(element, word, wordCue)
  }

  return <div className="study-page">
    <header className="study-header">
      <button className="study-back" onClick={onBack}><Icon name="chevronLeft"/>返回课程库</button>
      <div className="study-title">
        <div className="study-creator" style={{ background: video.color }}>{video.creator[0]}</div>
        <div><h1>{video.title}</h1><p>{video.subtitle} · {video.creator}</p></div>
      </div>
      <div className="study-header-actions">
        <span>{video.level} · {video.accent}</span>
        <button className={favorite ? 'saved' : ''} onClick={onFavorite}><Icon name="heart"/>{favorite ? '已收藏' : '收藏'}</button>
      </div>
    </header>

    <main className="study-layout">
      <section className="video-column">
        <div className={'learning-player' + (hiddenVideo ? ' video-hidden' : '')} style={{ backgroundImage: 'url(' + video.cover + ')' }}>
          <div className="player-tint"/>
          {hiddenVideo ? <div className="listen-only"><Icon name="volume" size={36}/><strong>听力专注模式</strong><p>画面已隐藏，试着只通过声音理解内容</p></div> : <>
            {!chineseSelfCheck && <div className="video-brand">SLOW ENGLISH <span>{video.level}</span></div>}
            <button className="center-play" onClick={toggleSpeechPlayback} aria-label={playing ? '暂停句子朗读' : '播放句子朗读'}><Icon name={playing ? 'pause' : 'play'} size={34}/></button>
            {playerCaption && <div className="video-caption"><PlayerCaption text={playerCaption} activeWordIndex={showEnglish ? activeWordIndex : null}/></div>}
          </>}
          <div className="native-controls">
            <span>{formatCueTime(Math.floor(playerTime))}</span>
            <div className={'native-track' + (playing ? ' is-playing' : '')}><i style={{ width: playerTrackWidth + '%' }}/></div>
            <span>{video.duration}</span>
          </div>
        </div>

        <div className="player-tools">
          <label className="speed-control">
            <span className="speed-label">倍速</span>
            <select aria-label="播放倍速" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
              {[.75, 1, 1.25, 1.5, 2].map((option) => <option key={option} value={option}>{option}×</option>)}
            </select>
          </label>
          <button className={hiddenVideo ? 'active' : ''} onClick={() => setHiddenVideo(!hiddenVideo)}><Icon name="volume"/><span>隐藏视频</span></button>
          <button onClick={() => go(current - 1)} disabled={current === 0}><Icon name="chevronLeft"/><span>上一句</span></button>
          <button className="main-control" onClick={toggleSpeechPlayback}><Icon name={playing ? 'pause' : 'play'}/><span>{playing ? '暂停' : '播放'}</span></button>
          <button onClick={() => go(current + 1)} disabled={current === learningCues.length - 1}><Icon name="chevronRight"/><span>下一句</span></button>
          <button className={loop ? 'active' : ''} onClick={() => setLoop(!loop)}><Icon name="repeat"/><span>单句循环</span></button>
          <button className={dictation ? 'active' : ''} onClick={() => setDictation(!dictation)}><Icon name="note"/><span>听写</span></button>
          <button><Icon name="fullscreen"/><span>全屏</span></button>
        </div>

        <section className="sentence-workbench">
          <div className="workbench-top"><span>第 {current + 1} / {learningCues.length} 句</span><span>{cueTimestamp(cue)}</span></div>
          {showDictation ? <div className="dictation-box"><p>听原声，写下你听到的句子</p><input placeholder="Type what you hear…"/><button onClick={() => setDictation(false)}>查看答案</button></div> : <>
            {showEnglish && <p className="focus-sentence">
              <InteractiveSentence
                text={cue.english}
                cue={cue}
                activeWordIndex={activeWordIndex}
                onOpen={openWord}
                onScheduleClose={scheduleWordClose}
                onContextMenu={openWordMenu}
                onLongPress={handleLongPress}
              />
            </p>}
            {showChinese && <p className={showEnglish ? 'focus-translation' : 'focus-sentence focus-sentence-chinese'}>{cue.chinese}</p>}
          </>}
          <div className="workbench-actions">
            <button onClick={toggleSpeechPlayback}><Icon name="volume"/>{playing ? '暂停原句' : '播放原句'}</button>
            {recorder.isRecording
              ? <button className="recording-button" onClick={recorder.stop}><span/>停止并保存</button>
              : <button onClick={recorder.start}><Icon name="microphone"/>跟读录音</button>}
            <button onClick={() => setTab('单词')}><Icon name="book"/>查看生词</button>
            <button><Icon name="note"/>记笔记</button>
            {recordingUrl && <audio controls src={recordingUrl}/>}
          </div>
          {recorder.error && <p className="record-error">{recorder.error}</p>}
        </section>
      </section>

      <aside className="transcript-panel">
        <div className="transcript-tabs">
          {(['双语', '英文', '中文', '单词'] as const).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}
        </div>
        <div className="transcript-heading">
          <div><span>{tab === '中文' ? '中文自测字幕' : tab === '英文' ? '英文字幕' : tab === '单词' ? '本句词汇释义' : 'AI 双语字幕'}</span><small><i/> 已人工校对</small></div>
          <button aria-label="字幕设置"><Icon name="settings" size={17}/></button>
        </div>
        {tab === '单词'
          ? <VocabularyPanel cue={cue} phraseEntries={phraseVocabulary} onOpenWord={openVocabularyItem} />
          : <ol className="cue-list">
            {learningCues.map((item, index) => <li key={item.id} className={index === current ? 'current' : ''}>
              <div className="cue-select">
                <button className="cue-select-target" onClick={() => go(index)} aria-label={'跳转到第 ' + (index + 1) + ' 句'} />
                <span className="cue-index">{index === current ? <Icon name="play" size={13}/> : String(index + 1).padStart(2, '0')}</span>
                <span className="cue-copy" onClick={() => go(index)}>
                  {showEnglish && <strong>
                    <InteractiveSentence
                      text={item.english}
                      cue={item}
                      activeWordIndex={index === current ? activeWordIndex : null}
                      onOpen={openWord}
                      onScheduleClose={scheduleWordClose}
                      onContextMenu={openWordMenu}
                      onLongPress={handleLongPress}
                    />
                  </strong>}
                  {showChinese && (chineseSelfCheck
                    ? <p className="cue-copy-chinese">{item.chinese}</p>
                    : <small>{item.chinese}</small>)}
                  <span className="cue-time"><Icon name="clock" size={11}/>{cueTimestamp(item)}</span>
                </span>
              </div>
              <div className="cue-mini-actions">
                <button aria-label="收藏句子"><Icon name="heart" size={15}/></button>
                <button aria-label="录制当前句"><Icon name="microphone" size={15}/></button>
              </div>
            </li>)}
          </ol>}
      </aside>
    </main>

    {activeWord && <DictionaryPopover
      word={activeWord.word}
      entry={lookupDictionaryEntry(activeWord.word)}
      contextEnglish={activeWord.cue.english}
      contextChinese={activeWord.cue.chinese}
      position={activeWord.position}
      onClose={() => setActiveWord(null)}
      onPointerEnter={clearCloseTimer}
      onPointerLeave={scheduleWordClose}
    />}
    {wordMenu && <ContextMenu
      word={wordMenu.word}
      x={wordMenu.x}
      y={wordMenu.y}
      alreadyAdded={isInVocabulary(wordMenu.normalizedWord)}
      onAdd={() => addWordToVocabulary(wordMenu)}
      onClose={() => setWordMenu(null)}
    />}
    {vocabularyNotice && <p className="vocabulary-notice" role="status">{vocabularyNotice}</p>}
  </div>
}

function VocabularyPanel({
  cue,
  phraseEntries,
  onOpenWord,
}: {
  cue: LearningCue
  phraseEntries: ReturnType<typeof getVocabularyEntriesForHighlights>
  onOpenWord: (element: HTMLElement, word: string, cue: LearningCue) => void
}) {
  return <div className="vocab-panel">
    <p>本句逐词释义 · {cue.wordTranslations.length} 项</p>
    <ul className="vocab-word-list" aria-label="本句逐词翻译">
      {cue.wordTranslations.map((item, index) => <li key={item.word + '-' + index}>
        <div className="vocab-word-label"><strong>{item.word}</strong><small>单词</small></div>
        <div className="vocab-word-meaning"><span>{item.translation}</span></div>
      </li>)}
    </ul>
    {phraseEntries.length > 0 && <section className="vocab-phrase-section" aria-label="本句完整词组翻译">
      <p>本句完整词组 · {phraseEntries.length} 项</p>
      <div className="vocab-phrase-list">
        {phraseEntries.map((entry) => <button
          key={entry.id}
          className="vocab-phrase-item"
          aria-label={'查看词组 ' + entry.word}
          onClick={(event) => onOpenWord(event.currentTarget, entry.word, cue)}
        >
          <span className="vocab-phrase-copy"><strong>{entry.word}</strong><small>{entry.meaning}</small></span>
          <span className="vocab-phrase-meta"><em>{entry.level}</em><Icon name="chevronRight" size={16}/></span>
        </button>)}
      </div>
    </section>}
  </div>
}
