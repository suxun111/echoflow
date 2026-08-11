import { useEffect, useMemo, useRef, useState } from 'react'
import type { CourseVocabulary } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import { getPrivateCourse, translatePrivateCourse, type PrivateLessonDetail } from '../../lib/privateCourseApi'

type SubtitleTab = '双语' | '英文' | '中文' | '单词'

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function cueForTime(course: PrivateLessonDetail, timeMs: number) {
  return course.cues.findIndex((cue) => timeMs >= cue.startMs && timeMs < cue.endMs)
}

function vocabularySourceLabel(source: CourseVocabulary['translationSource']) {
  if (source === 'VOLCENGINE') return '火山翻译'
  if (source === 'LOCAL_FALLBACK') return '本地词库 fallback'
  return '暂无来源'
}

function vocabularyTranslationLabel(term: CourseVocabulary) {
  if (term.translationStatus === 'TRANSLATED' && term.translation.trim()) return `${term.translation} · ${vocabularySourceLabel(term.translationSource)}`
  if (term.translationStatus === 'RETRYABLE_FAILED') return `待重试 · ${term.translationErrorCode ?? 'UPSTREAM_ERROR'}`
  if (term.translationStatus === 'PERMANENT_FAILED') return `暂不可用 · ${term.translationErrorCode ?? 'TRANSLATION_FAILED'}`
  return '待翻译'
}

const emptyCoverage = { translatedCount: 0, totalCount: 0, missingCount: 0, status: 'not_started' as const, warnings: [] as string[] }

function CourseVocabularyList({ terms, emptyMessage = '暂未生成词汇' }: { terms: CourseVocabulary[]; emptyMessage?: string }) {
  if (!terms.length) return <div className="private-vocabulary-empty">{emptyMessage}</div>
  return <ul className="private-course-vocabulary-list">
    {terms.map((term) => <li key={term.id} data-term-type={term.termType}>
      <div><strong>{term.word}</strong><small>{term.termType === 'PHRASE' ? '词组 / 短语' : '单词'}</small></div>
      <span className={term.translationStatus === 'TRANSLATED' ? 'translated' : 'untranslated'}>{vocabularyTranslationLabel(term)}</span>
    </li>)}
  </ul>
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
  const [translationBusy, setTranslationBusy] = useState(false)
  const [translationNotice, setTranslationNotice] = useState<string | null>(null)

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
  const vocabulary = course?.vocabulary ?? []
  const vocabularyTranslation = course?.vocabularyTranslation ?? emptyCoverage
  const currentVocabulary = useMemo(() => vocabulary.filter((term) => term.sourceCueId === currentCue?.id), [currentCue?.id, vocabulary])
  const showEnglish = tab === '双语' || tab === '英文'
  const showChinese = tab === '双语' || tab === '中文'
  const showCaption = tab !== '单词' && (showEnglish || showChinese)

  useEffect(() => {
    if (!course || vocabularyTranslation.status !== 'processing') return
    const timer = window.setTimeout(() => { void loadCourse() }, 2000)
    return () => window.clearTimeout(timer)
  }, [course, vocabularyTranslation.status])

  const requestVocabularyTranslation = async () => {
    if (!course || translationBusy) return
    setTranslationBusy(true)
    try {
      const response = await translatePrivateCourse(course.id)
      setTranslationNotice(`词汇翻译任务已提交：${response.vocabularyCoverage.translatedCount}/${response.vocabularyCoverage.totalCount}`)
      await loadCourse()
    } catch (translationError) {
      setTranslationNotice(translationError instanceof Error ? translationError.message : '无法提交词汇补译任务')
    } finally {
      setTranslationBusy(false)
    }
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
    <header className="study-header"><button className="study-back" onClick={onBack}><Icon name="chevronLeft" size={16}/>返回上传课程</button><div className="study-title"><span className="study-creator">MP4</span><div><h1>{course.title}</h1><p>{course.creator} · 私有课程</p></div></div><div className="study-header-actions"><span>字幕 {course.translation.translatedCount}/{course.translation.totalCount}</span><span>词汇 {vocabularyTranslation.translatedCount}/{vocabularyTranslation.totalCount}</span>{vocabularyTranslation.status !== 'completed' && <button onClick={() => void requestVocabularyTranslation()} disabled={translationBusy || vocabularyTranslation.status === 'processing'}>{vocabularyTranslation.status === 'processing' ? '翻译中…' : translationBusy ? '提交中…' : '补译词汇'}</button>}</div></header>
    {error && <p className="private-inline-error" role="alert">{error}<button onClick={() => void loadCourse()}>刷新播放地址</button></p>}
    {course.warnings.length > 0 && <p className="private-warning" role="status">中文翻译未完整生成：{course.warnings.join('；')}。英文字幕和视频仍可使用。</p>}
    {translationNotice && <p className="private-warning" role="status">{translationNotice}</p>}
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
            {showEnglish && <p className="focus-sentence">{currentCue.english}</p>}
            {showChinese && <p className="focus-translation">{currentCue.chinese || '中文翻译暂未生成'}</p>}
          </>}
          {tab === '单词' && <CourseVocabularyList terms={currentVocabulary}/>} 
          <div className="workbench-actions"><button onClick={() => setCurrentIndex((index) => { const next = Math.max(0, index - 1); if (course.cues[next]) seek(course.cues[next].startMs / 1000); return next })} disabled={currentIndex === 0}>上一句</button><button onClick={() => setCurrentIndex((index) => { const next = Math.min(course.cues.length - 1, index + 1); if (course.cues[next]) seek(course.cues[next].startMs / 1000); return next })} disabled={currentIndex >= course.cues.length - 1}>下一句</button><button onClick={() => currentCue && seek(currentCue.startMs / 1000, true)} disabled={!currentCue}>播放本句</button></div>
        </section>
      </section>
      <aside className="transcript-panel private-transcript-panel">
        <div className="transcript-tabs">{(['双语', '英文', '中文', '单词'] as SubtitleTab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
        <div className="transcript-heading"><div><span>{tab === '单词' ? '课程词汇' : '真实字幕'}</span><small>{course.cues.length} 句 · 由 MOSS 生成</small></div><Icon name="note" size={16}/></div>
        {tab === '单词' ? <CourseVocabularyList terms={vocabulary}/> : <ol className="cue-list">{course.cues.map((cue, index) => <li key={cue.id} className={index === currentIndex ? 'current' : ''}><button className="cue-select" data-cue-start-ms={cue.startMs} data-cue-end-ms={cue.endMs} onClick={() => { setCurrentIndex(index); seek(cue.startMs / 1000) }}><span className="cue-index">{index + 1}</span><span className="cue-copy">{cue.speaker && <em>{cue.speaker}</em>}{showEnglish && <strong>{cue.english}</strong>}{showChinese && <small>{cue.chinese || '中文翻译暂未生成'}</small>}<i>{formatTime(cue.startMs / 1000)}</i></span></button></li>)}</ol>}
      </aside>
    </div>
  </main>
}
