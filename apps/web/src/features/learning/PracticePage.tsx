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
  onOpen: (element: HTMLElement, word: string, cue: LearningCue) => void
  onScheduleClose: () => void
  onContextMenu: (event: MouseEvent<HTMLSpanElement>, word: string, cue: LearningCue) => void
  onLongPress: (element: HTMLElement, word: string, cue: LearningCue) => void
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
  onOpen,
  onScheduleClose,
  onContextMenu,
  onLongPress,
}: InteractiveSentenceProps) {
  const longPressTimer = useRef<number | null>(null)
  const longPressHandled = useRef(false)

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

  return <>
    {segmentCueText(text, cue.highlight).map((segment, index) => {
      if (!segment.entry) return segment.value

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
          {segment.value}
        </span>
      )
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
  const closeTimer = useRef<number | null>(null)
  const noticeTimer = useRef<number | null>(null)
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

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
  }, [recordingUrl])

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
    setActiveWord(null)
    setWordMenu(null)
  }, [current])

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
            <button className="center-play" onClick={() => setPlaying(!playing)}><Icon name={playing ? 'pause' : 'play'} size={34}/></button>
            {playerCaption && <div className="video-caption">{playerCaption}</div>}
          </>}
          <div className="native-controls">
            <span>{formatCueTime(cue.start)}</span>
            <div className="native-track"><i style={{ width: (cue.start / 36) * 100 + '%' }}/></div>
            <span>{video.duration}</span>
          </div>
        </div>

        <div className="player-tools">
          <button onClick={() => setSpeed(speed === 1.5 ? .75 : speed + .25)}><strong>{speed}x</strong><span>倍速</span></button>
          <button className={hiddenVideo ? 'active' : ''} onClick={() => setHiddenVideo(!hiddenVideo)}><Icon name="volume"/><span>隐藏视频</span></button>
          <button onClick={() => go(current - 1)} disabled={current === 0}><Icon name="chevronLeft"/><span>上一句</span></button>
          <button className="main-control" onClick={() => setPlaying(!playing)}><Icon name={playing ? 'pause' : 'play'}/><span>{playing ? '暂停' : '播放'}</span></button>
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
                onOpen={openWord}
                onScheduleClose={scheduleWordClose}
                onContextMenu={openWordMenu}
                onLongPress={handleLongPress}
              />
            </p>}
            {showChinese && <p className={showEnglish ? 'focus-translation' : 'focus-sentence focus-sentence-chinese'}>{cue.chinese}</p>}
          </>}
          <div className="workbench-actions">
            <button onClick={() => setPlaying(true)}><Icon name="volume"/>播放原句</button>
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
                      onOpen={openWord}
                      onScheduleClose={scheduleWordClose}
                      onContextMenu={openWordMenu}
                      onLongPress={handleLongPress}
                    />
                  </strong>}
                  {showChinese && (chineseSelfCheck
                    ? <p className="cue-copy-chinese">{item.chinese}</p>
                    : <small>{item.chinese}</small>)}
                  <em>{cueTimestamp(item)}</em>
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
        <strong>{item.word}</strong><span>{item.translation}</span>
      </li>)}
    </ul>
    {phraseEntries.length > 0 && <section className="vocab-phrase-section" aria-label="本句完整词组翻译">
      <p>本句完整词组 · {phraseEntries.length} 项</p>
      {phraseEntries.map((entry) => <button key={entry.id} onClick={(event) => onOpenWord(event.currentTarget, entry.word, cue)}>
        <span><strong>{entry.word}</strong><small>{entry.meaning}</small></span>
        <em>{entry.level}</em><Icon name="volume" size={16}/>
      </button>)}
    </section>}
  </div>
}
