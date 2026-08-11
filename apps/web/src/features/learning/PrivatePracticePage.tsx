import {
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
import { getCueVocabulary, normalizeVocabularyTerm, type CueVocabulary, type DictionaryEntry } from '../../data/dictionary'
import { getPrivateCourse, type PrivateLessonDetail } from '../../lib/privateCourseApi'
import { addVocabularyWord, isInVocabulary } from '../../lib/vocabularyStore'

type SubtitleTab = '双语' | '英文' | '中文' | '单词'

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function cueForTime(course: PrivateLessonDetail, timeMs: number) {
  return course.cues.findIndex((cue) => timeMs >= cue.startMs && timeMs < cue.endMs)
}

type PrivateCue = PrivateLessonDetail['cues'][number]

type ActivePrivateWord = {
  word: string
  normalizedWord: string
  entry?: DictionaryEntry
  cue: PrivateCue
  position: PopoverPosition
}

type PrivateWordMenu = ActivePrivateWord & {
  x: number
  y: number
}

type InteractivePrivateSentenceProps = {
  text: string
  cue: PrivateCue
  vocabulary: CueVocabulary
  onOpen: (element: HTMLElement, word: string, entry: DictionaryEntry | undefined) => void
  onContextMenu: (event: MouseEvent<HTMLSpanElement>, word: string, entry: DictionaryEntry | undefined) => void
  onLongPress: (element: HTMLElement, word: string, entry: DictionaryEntry | undefined) => void
}

const privateWordTokenPattern = /^[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*$/

function InteractivePrivateSentence({ text, cue, vocabulary, onOpen, onContextMenu, onLongPress }: InteractivePrivateSentenceProps) {
  const longPressTimer = useRef<number | null>(null)
  const longPressHandled = useRef(false)

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const startLongPress = (element: HTMLElement, word: string, entry: DictionaryEntry | undefined) => {
    clearLongPress()
    longPressHandled.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressHandled.current = true
      longPressTimer.current = null
      onLongPress(element, word, entry)
    }, 550)
  }

  useEffect(() => clearLongPress, [])

  const openWord = (event: MouseEvent<HTMLSpanElement> | FocusEvent<HTMLSpanElement>, word: string, entry: DictionaryEntry | undefined) => {
    onOpen(event.currentTarget, word, entry)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>, word: string, entry: DictionaryEntry | undefined) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onOpen(event.currentTarget, word, entry)
  }

  let wordIndex = 0
  const tokens = text.split(/([A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*)/g).filter(Boolean)

  return <>
    {tokens.map((token, index) => {
      if (!privateWordTokenPattern.test(token)) return token
      const item = vocabulary.words[wordIndex++] ?? { word: token }
      const normalizedWord = normalizeVocabularyTerm(item.word)
      return <span
        key={`${cue.id}-${normalizedWord}-${index}`}
        className={`interactive-word ${item.entry ? 'is-highlighted' : 'is-missing'}`}
        role="button"
        tabIndex={0}
        data-word={item.word}
        data-normalized-word={normalizedWord}
        data-cue-id={cue.id}
        aria-label={`查询 ${item.word}`}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') openWord(event, item.word, item.entry) }}
        onFocus={(event) => openWord(event, item.word, item.entry)}
        onClick={(event) => {
          event.stopPropagation()
          if (longPressHandled.current) {
            longPressHandled.current = false
            return
          }
          openWord(event, item.word, item.entry)
        }}
        onKeyDown={(event) => handleKeyDown(event, item.word, item.entry)}
        onContextMenu={(event) => onContextMenu(event, item.word, item.entry)}
        onPointerDown={(event: PointerEvent<HTMLSpanElement>) => { if (event.pointerType === 'touch') startLongPress(event.currentTarget, item.word, item.entry) }}
        onPointerMove={clearLongPress}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onTouchStart={(event) => startLongPress(event.currentTarget, item.word, item.entry)}
        onTouchMove={clearLongPress}
        onTouchEnd={clearLongPress}
        onTouchCancel={clearLongPress}
      >{item.word}</span>
    })}
  </>
}

export function PrivatePracticePage({ courseId, onBack }: { courseId: string; onBack: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [course, setCourse] = useState<PrivateLessonDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [loop, setLoop] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(0.8)
  const [muted, setMuted] = useState(false)
  const [tab, setTab] = useState<SubtitleTab>('双语')
  const [activeWord, setActiveWord] = useState<ActivePrivateWord | null>(null)
  const [wordMenu, setWordMenu] = useState<PrivateWordMenu | null>(null)
  const [vocabularyNotice, setVocabularyNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)

  const loadCourse = async () => {
    try {
      setCourse(await getPrivateCourse(courseId))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法加载私有课程')
    }
  }

  useEffect(() => { void loadCourse() }, [courseId])
  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = speed
  }, [speed])
  useEffect(() => {
    const video = videoRef.current
    if (video) { video.volume = volume; video.muted = muted }
  }, [muted, volume])

  const currentCue = useMemo(() => course?.cues[currentIndex] ?? null, [course, currentIndex])
  const currentVocabulary = useMemo(() => currentCue ? getCueVocabulary(currentCue.english, currentCue.keywords) : null, [currentCue])
  const showEnglish = tab === '双语' || tab === '英文'
  const showChinese = tab === '双语' || tab === '中文'
  const showCaption = tab !== '单词' && (showEnglish || showChinese)

  useEffect(() => {
    setActiveWord(null)
    setWordMenu(null)
  }, [currentIndex, tab])

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Element
      if (!target.closest('.interactive-word') && !target.closest('.dictionary-popover') && !target.closest('.word-context-menu')) {
        setActiveWord(null)
        setWordMenu(null)
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

  const showVocabularyNotice = (message: string) => {
    setVocabularyNotice(message)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setVocabularyNotice(null), 2400)
  }

  const openWord = (element: HTMLElement, word: string, entry: DictionaryEntry | undefined) => {
    if (!currentCue) return
    const rect = element.getBoundingClientRect()
    setWordMenu(null)
    setActiveWord({
      word,
      normalizedWord: normalizeVocabularyTerm(word),
      entry,
      cue: currentCue,
      position: { top: rect.top, left: rect.left, bottom: rect.bottom },
    })
  }

  const addWordToVocabulary = (wordState: ActivePrivateWord) => {
    if (!course) return
    const result = addVocabularyWord({
      word: wordState.word,
      meaning: wordState.entry?.meaning ?? '本地词库暂未收录该单词',
      level: wordState.entry?.level ?? '未分级',
      exampleEnglish: wordState.entry?.exampleEnglish ?? wordState.cue.english,
      exampleChinese: wordState.entry?.exampleChinese ?? wordState.cue.chinese,
      contextEnglish: wordState.cue.english,
      contextChinese: wordState.cue.chinese,
      lessonId: course.id,
      lessonTitle: course.title,
      cueId: wordState.cue.id,
      timestamp: `${formatTime(wordState.cue.startMs / 1000)} - ${formatTime(wordState.cue.endMs / 1000)}`,
    })
    showVocabularyNotice(result.added ? `${wordState.word} 已加入生词本` : `${wordState.word} 已在生词本`)
    setWordMenu(null)
  }

  const openWordMenu = (event: MouseEvent<HTMLSpanElement>, word: string, entry: DictionaryEntry | undefined) => {
    event.preventDefault()
    if (!currentCue) return
    const rect = event.currentTarget.getBoundingClientRect()
    setActiveWord(null)
    setWordMenu({
      word,
      normalizedWord: normalizeVocabularyTerm(word),
      entry,
      cue: currentCue,
      position: { top: rect.top, left: rect.left, bottom: rect.bottom },
      x: event.clientX,
      y: event.clientY,
    })
  }

  const handleLongPress = (element: HTMLElement, word: string, entry: DictionaryEntry | undefined) => {
    openWord(element, word, entry)
  }

  const togglePlayback = async () => {
    const video = videoRef.current
    if (!video) return
    if (ended) {
      video.currentTime = 0
      setEnded(false)
    }
    if (video.paused) await video.play().catch((playError: unknown) => setError(playError instanceof Error ? playError.message : '视频无法播放'))
    else video.pause()
  }

  const seek = (time: number, shouldPlay = false) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(time, video.duration || course?.durationSeconds || 0))
    if (shouldPlay) void video.play().catch(() => undefined)
  }

  const onTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !course) return
    const time = video.currentTime
    setCurrentTime(time)
    const activeCue = course.cues[currentIndex]
    if (loop && activeCue && time * 1000 >= activeCue.endMs - 25) {
      seek(activeCue.startMs / 1000, true)
      return
    }
    const cueIndex = cueForTime(course, time * 1000)
    if (cueIndex >= 0) {
      setCurrentIndex(cueIndex)
    }
  }

  if (error && !course) return <main className="private-learning-state"><h1>无法打开私有课程</h1><p>{error}</p><button onClick={() => void loadCourse()}>重新加载</button><button onClick={onBack}>返回课程列表</button></main>
  if (!course) return <main className="private-learning-state"><p role="status">正在加载私有视频课程…</p></main>

  return <main className="study-page private-study-page">
    <header className="study-header"><button className="study-back" onClick={onBack}><Icon name="chevronLeft" size={16}/>返回上传课程</button><div className="study-title"><span className="study-creator">MP4</span><div><h1>{course.title}</h1><p>{course.creator} · 私有课程</p></div></div><div className="study-header-actions"><span>{course.cues.length} 条真实字幕</span></div></header>
    {error && <p className="private-inline-error" role="alert">{error}<button onClick={() => void loadCourse()}>刷新播放地址</button></p>}
    {course.warnings.length > 0 && <p className="private-warning" role="status">中文翻译未完整生成：{course.warnings.join('；')}。英文字幕和视频仍可使用。</p>}
    <div className="study-layout">
      <section className="video-column">
        <div className="learning-player private-media-player">
          <video ref={videoRef} data-testid="private-video" src={course.playbackUrl} poster={course.coverUrl ?? undefined} preload="metadata" playsInline onTimeUpdate={onTimeUpdate} onPlay={() => { setPlaying(true); setEnded(false) }} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setEnded(true) }} onError={() => setError('视频播放地址已失效或媒体暂不可用，请刷新播放地址')}/>
          {!playing && <button className="center-play" onClick={() => void togglePlayback()} aria-label={ended ? '重新播放视频' : '播放视频'}><Icon name={ended ? 'repeat' : 'play'} size={29}/></button>}
          {showCaption && currentCue && <div className="video-caption private-video-caption" data-speaker={currentCue.speaker ?? undefined}>
            {currentCue.speaker && <b>{currentCue.speaker}</b>}
            {showEnglish && <strong>{currentCue.english}</strong>}
            {showChinese && currentCue.chinese && <small>{currentCue.chinese}</small>}
          </div>}
          <div className="private-video-controls">
            <button data-testid="private-video-toggle" onClick={() => void togglePlayback()} aria-label={playing ? '暂停' : '播放'}><Icon name={playing ? 'pause' : 'play'} size={17}/></button>
            <span>{formatTime(currentTime)} / {formatTime(videoRef.current?.duration || course.durationSeconds)}</span>
            <input data-testid="private-video-progress" aria-label="视频进度" type="range" min="0" max={videoRef.current?.duration || course.durationSeconds || 1} step="0.1" value={currentTime} onChange={(event) => seek(Number(event.target.value))}/>
            <button data-testid="private-video-mute" onClick={() => setMuted(!muted)} aria-label={muted ? '取消静音' : '静音'}><Icon name="volume" size={17}/></button>
            <input aria-label="音量" className="private-volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => { setVolume(Number(event.target.value)); setMuted(false) }}/>
          </div>
        </div>
        <div className="player-tools private-player-tools">
          <button className="main-control" onClick={() => void togglePlayback()}><Icon name={playing ? 'pause' : 'play'} size={17}/><strong>{playing ? '暂停' : ended ? '重播' : '播放'}</strong></button>
          <button className={loop ? 'active' : ''} onClick={() => setLoop(!loop)}><Icon name="repeat" size={17}/><span>单句循环</span></button>
          <button onClick={() => currentCue && seek(currentCue.startMs / 1000, true)} disabled={!currentCue}><Icon name="repeat" size={17}/><span>重播本句</span></button>
          <label className="private-speed">倍速<select data-testid="private-video-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.75">0.75x</option><option value="1">1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option></select></label>
        </div>
        <section className="sentence-workbench private-workbench">
          <div className="workbench-top"><span>{currentCue ? `${formatTime(currentCue.startMs / 1000)} - ${formatTime(currentCue.endMs / 1000)}` : '等待字幕'} </span><span>{ended ? '播放结束，可重新播放' : playing ? '正在按真实时间轴同步' : '可从任一句开始学习'}</span></div>
          {tab !== '单词' && currentCue && <>
            {showEnglish && currentVocabulary && <p className="focus-sentence"><InteractivePrivateSentence text={currentCue.english} cue={currentCue} vocabulary={currentVocabulary} onOpen={openWord} onContextMenu={openWordMenu} onLongPress={handleLongPress}/></p>}
            {showChinese && <p className="focus-translation">{currentCue.chinese || '中文翻译暂未生成'}</p>}
          </>}
          {tab === '单词' && currentCue && currentVocabulary && <PrivateVocabularyPanel cue={currentCue} vocabulary={currentVocabulary} onOpenWord={openWord}/>}
          <div className="workbench-actions"><button onClick={() => setCurrentIndex((index) => { const next = Math.max(0, index - 1); if (course.cues[next]) seek(course.cues[next].startMs / 1000); return next })} disabled={currentIndex === 0}>上一句</button><button onClick={() => setCurrentIndex((index) => { const next = Math.min(course.cues.length - 1, index + 1); if (course.cues[next]) seek(course.cues[next].startMs / 1000); return next })} disabled={currentIndex >= course.cues.length - 1}>下一句</button><button onClick={() => currentCue && seek(currentCue.startMs / 1000, true)} disabled={!currentCue}>播放本句</button></div>
        </section>
      </section>
      <aside className="transcript-panel private-transcript-panel">
        <div className="transcript-tabs">{(['双语', '英文', '中文', '单词'] as SubtitleTab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
        <div className="transcript-heading"><div><span>{tab === '单词' ? '课程词汇' : '真实字幕'}</span><small>{course.cues.length} 句 · 中文 {course.translation.translatedCount}/{course.translation.totalCount}</small></div><Icon name="note" size={16}/></div>
        {tab === '单词' ? currentCue && currentVocabulary && <PrivateVocabularyPanel cue={currentCue} vocabulary={currentVocabulary} onOpenWord={openWord}/> : <ol className="cue-list">{course.cues.map((cue, index) => <li key={cue.id} className={index === currentIndex ? 'current' : ''}><button className="cue-select" data-cue-start-ms={cue.startMs} data-cue-end-ms={cue.endMs} onClick={() => { setCurrentIndex(index); seek(cue.startMs / 1000) }}><span className="cue-index">{index + 1}</span><span className="cue-copy">{cue.speaker && <em>{cue.speaker}</em>}{showEnglish && <strong>{cue.english}</strong>}{showChinese && <small>{cue.chinese || '中文翻译暂未生成'}</small>}<i>{formatTime(cue.startMs / 1000)}</i></span></button></li>)}</ol>}
      </aside>
    </div>
    {activeWord && <DictionaryPopover
      word={activeWord.word}
      entry={activeWord.entry}
      contextEnglish={activeWord.cue.english}
      contextChinese={activeWord.cue.chinese}
      position={activeWord.position}
      onClose={() => setActiveWord(null)}
      onPointerEnter={() => undefined}
      onPointerLeave={() => undefined}
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
  </main>
}

function PrivateVocabularyPanel({
  cue,
  vocabulary,
  onOpenWord,
}: {
  cue: PrivateCue
  vocabulary: CueVocabulary
  onOpenWord: (element: HTMLElement, word: string, entry: DictionaryEntry | undefined) => void
}) {
  return <div className="vocab-panel private-vocabulary-panel" data-testid="private-vocabulary-panel">
    <p>当前真实 cue 逐词释义 · {vocabulary.coveredWordCount}/{vocabulary.totalWordCount} 已收录</p>
    <ul className="vocab-word-list" aria-label="当前真实字幕逐词词典">
      {vocabulary.words.map((item, index) => <li key={`${cue.id}-${item.word}-${index}`} className={item.entry ? '' : 'is-missing'}>
        <button type="button" onClick={(event) => onOpenWord(event.currentTarget, item.word, item.entry)}>
          <strong>{item.word}</strong>
          <span>{item.entry ? `${item.entry.partOfSpeech} · ${item.entry.meaning}` : '本地词库暂未收录该单词'}</span>
        </button>
      </li>)}
    </ul>
    {vocabulary.phrases.length > 0 && <section className="vocab-phrase-section private-vocab-phrases" aria-label="当前真实字幕完整词组翻译">
      <p>当前 cue 完整词组 · {vocabulary.phrases.length} 项</p>
      {vocabulary.phrases.map((entry) => <button type="button" key={entry.id} onClick={(event) => onOpenWord(event.currentTarget, entry.word, entry)}>
        <span><strong>{entry.word}</strong><small>{entry.meaning}</small></span>
        <em>{entry.level}</em><Icon name="volume" size={16}/>
      </button>)}
    </section>}
  </div>
}
