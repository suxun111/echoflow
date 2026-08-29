import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveTranscriptView, MediaAssetView, TranscriptCueView } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import { formatCueTimestamp, formatMediaDuration } from '../library/mediaStatus'

export type V1PreviewPlaybackState =
  | { kind: 'idle' }
  | { kind: 'loading'; assetId: string }
  | { kind: 'ready'; assetId: string; url: string }
  | { kind: 'error'; assetId: string; message: string }

export type V1PreviewTranscriptState =
  | { kind: 'idle' }
  | { kind: 'loading'; assetId: string }
  | { kind: 'ready'; assetId: string; value: ActiveTranscriptView }
  | { kind: 'not-ready'; assetId: string }
  | { kind: 'error'; assetId: string; message: string }

type StudyMode = 'watch' | 'shadow' | 'listen'

const modes: { id: StudyMode; label: string; eyebrow: string; description: string }[] = [
  { id: 'watch', label: '观看', eyebrow: 'WATCH', description: '看原片并跟随完整英文字幕' },
  { id: 'shadow', label: '跟读', eyebrow: 'SHADOW', description: '聚焦当前英语句，按句模仿' },
  { id: 'listen', label: '精听', eyebrow: 'LISTEN', description: '隐藏字幕，只保留原片声音' },
]

const speeds = [0.75, 1, 1.25, 1.5]
const cueWindowSize = 80

function findCueAt(cues: TranscriptCueView[], positionMs: number): number | null {
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const cue = cues[middle]
    if (positionMs < cue.startMs) high = middle - 1
    else if (positionMs >= cue.endMs) low = middle + 1
    else return middle
  }

  return null
}

function cueWindow(cues: TranscriptCueView[], anchor: number) {
  if (cues.length <= cueWindowSize) return { start: 0, cues }
  const start = Math.min(Math.max(anchor - Math.floor(cueWindowSize / 2), 0), cues.length - cueWindowSize)
  return { start, cues: cues.slice(start, start + cueWindowSize) }
}

function PreviewStatus({ playback, transcript, onVerifyPlayback, onVerifyTranscript }: {
  playback: V1PreviewPlaybackState
  transcript: V1PreviewTranscriptState
  onVerifyPlayback: () => void
  onVerifyTranscript: () => void
}) {
  return <div className="v1-preview-gate" role="status">
    <span className="v1-preview-gate-mark"><i/><i/><i/><i/><i/></span>
    <p>REAL DATA GATE</p>
    <h4>学习界面尚未解锁</h4>
    <span>必须同时取得当前媒体的真实播放地址与唯一 ACTIVE 英文字幕。这里不会填入样例字幕或静态课程。</span>
    <div className="v1-preview-gate-actions">
      {playback.kind === 'loading'
        ? <button disabled>正在验证原片…</button>
        : playback.kind !== 'ready' && <button onClick={onVerifyPlayback}>{playback.kind === 'error' ? '重新验证原片' : '验证原片'}</button>}
      {transcript.kind === 'loading'
        ? <button disabled>正在检查字幕…</button>
        : transcript.kind !== 'ready' && <button onClick={onVerifyTranscript}>{transcript.kind === 'error' ? '重新检查字幕' : '检查 ACTIVE 字幕'}</button>}
    </div>
    {playback.kind === 'error' && <small role="alert">{playback.message}</small>}
    {transcript.kind === 'not-ready' && <small>当前没有可读取的完整英文字幕；部分结果不会进入学习界面。</small>}
    {transcript.kind === 'error' && <small role="alert">{transcript.message}</small>}
  </div>
}

function TranscriptGate({ playback, transcript, onVerifyTranscript }: {
  playback: V1PreviewPlaybackState
  transcript: V1PreviewTranscriptState
  onVerifyTranscript: () => void
}) {
  const copy = transcript.kind === 'ready'
    ? { title: '英文字幕已确认', detail: playback.kind === 'ready' ? '正在准备学习界面。' : '还需要验证当前原片播放地址。' }
    : transcript.kind === 'not-ready'
      ? { title: '完整英文字幕尚未准备好', detail: '部分字幕不会进入学习界面。' }
      : transcript.kind === 'error'
        ? { title: '暂时无法读取英文字幕', detail: transcript.message }
        : transcript.kind === 'loading'
          ? { title: '正在检查 ACTIVE 字幕', detail: '只接受当前媒体唯一完整的英文版本。' }
          : { title: '等待检查完整英文字幕', detail: '确认后才会显示真实 Cue 列表。' }

  return <div className="v1-transcript-gate" role="status">
    <span className="v1-transcript-gate-orbit"><i/><i/></span>
    <strong>{copy.title}</strong>
    <p>{copy.detail}</p>
    {(transcript.kind === 'idle' || transcript.kind === 'error') && <button type="button" onClick={onVerifyTranscript}>{transcript.kind === 'error' ? '重新检查字幕' : '检查 ACTIVE 字幕'}</button>}
  </div>
}

function CueText({ cue, mode, positionMs }: { cue: TranscriptCueView; mode: StudyMode; positionMs: number }) {
  if (mode !== 'shadow' || cue.words.length === 0) return <>{cue.text}</>

  return <>{cue.words.map((word, index) => <span
    key={`${word.startMs}-${word.endMs}-${index}`}
    className={positionMs >= word.startMs ? 'spoken' : undefined}
  >{word.text}{index < cue.words.length - 1 ? ' ' : ''}</span>)}</>
}

export function V1LearningPreview({ asset, playback, transcript, onVerifyPlayback, onVerifyTranscript }: {
  asset: MediaAssetView
  playback: V1PreviewPlaybackState
  transcript: V1PreviewTranscriptState
  onVerifyPlayback: () => void
  onVerifyTranscript: () => void
}) {
  const [mode, setMode] = useState<StudyMode>('watch')
  const [selectedCueIndex, setSelectedCueIndex] = useState(0)
  const [activeCueIndex, setActiveCueIndex] = useState<number | null>(null)
  const [positionMs, setPositionMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loopCueIndex, setLoopCueIndex] = useState<number | null>(null)
  const [speed, setSpeed] = useState(1)
  const videoRef = useRef<HTMLVideoElement>(null)
  const cueListRef = useRef<HTMLOListElement>(null)

  const playbackUrl = playback.kind === 'ready' && playback.assetId === asset.id ? playback.url : null
  const activeTranscript = transcript.kind === 'ready' && transcript.assetId === asset.id && transcript.value.mediaAssetId === asset.id
    ? transcript.value
    : null
  const cues = activeTranscript?.cues ?? []
  const ready = Boolean(playbackUrl && activeTranscript && cues.length > 0)
  const selectedCue = cues[selectedCueIndex] ?? null
  const activeCue = activeCueIndex === null ? null : cues[activeCueIndex] ?? null
  const visible = useMemo(() => cueWindow(cues, activeCueIndex ?? selectedCueIndex), [activeCueIndex, cues, selectedCueIndex])

  useEffect(() => {
    setMode('watch')
    setSelectedCueIndex(0)
    setActiveCueIndex(null)
    setPositionMs(0)
    setPlaying(false)
    setLoopCueIndex(null)
    setSpeed(1)
  }, [asset.id, activeTranscript?.id, playbackUrl])

  useEffect(() => {
    if (!ready) {
      setLoopCueIndex(null)
      setPlaying(false)
    }
  }, [ready])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = speed
  }, [speed])

  useEffect(() => {
    if (activeCueIndex === null) return
    cueListRef.current?.querySelector<HTMLElement>(`[data-cue-index="${activeCueIndex}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeCueIndex, visible.start])

  const seekToCue = useCallback((index: number) => {
    const cue = cues[index]
    const video = videoRef.current
    if (!cue || !video || !ready) return
    video.currentTime = cue.startMs / 1000
    setPositionMs(cue.startMs)
    setSelectedCueIndex(index)
    setActiveCueIndex(index)
    setLoopCueIndex((current) => current === null ? null : index)
  }, [cues, ready])

  const updateFromVideo = useCallback((video: HTMLVideoElement) => {
    if (!ready) return
    const nextPositionMs = Math.max(0, Math.round(video.currentTime * 1000))
    const loopCue = loopCueIndex === null ? null : cues[loopCueIndex]
    if (loopCue && loopCueIndex !== null && nextPositionMs >= loopCue.endMs) {
      video.currentTime = loopCue.startMs / 1000
      setPositionMs(loopCue.startMs)
      setSelectedCueIndex(loopCueIndex)
      setActiveCueIndex(loopCueIndex)
      if (!video.paused) void video.play().catch(() => setPlaying(false))
      return
    }

    setPositionMs(nextPositionMs)
    const nextCueIndex = findCueAt(cues, nextPositionMs)
    setActiveCueIndex(nextCueIndex)
    if (nextCueIndex !== null) setSelectedCueIndex(nextCueIndex)
  }, [cues, loopCueIndex, ready])

  function togglePlayback() {
    const video = videoRef.current
    if (!video || !ready) return
    if (video.paused) void video.play().catch(() => setPlaying(false))
    else video.pause()
  }

  function cycleSpeed() {
    const currentIndex = speeds.indexOf(speed)
    setSpeed(speeds[(currentIndex + 1) % speeds.length])
  }

  function toggleLoop() {
    if (!ready || !selectedCue) return
    if (loopCueIndex !== null) {
      setLoopCueIndex(null)
      return
    }
    setLoopCueIndex(selectedCueIndex)
    seekToCue(selectedCueIndex)
  }

  const modeCopy = modes.find((item) => item.id === mode) ?? modes[0]
  const transcriptState = transcript.kind === 'ready' ? 'ACTIVE' : transcript.kind === 'not-ready' ? 'NOT READY' : transcript.kind.toUpperCase()

  return <section className="v1-learning-preview" data-ready={ready ? 'true' : 'false'} data-mode={mode}>
    <header className="v1-preview-heading">
      <div>
        <p>V1 INTERFACE ADAPTER</p>
        <h3>旧版学习框架 · 真实数据适配</h3>
        <span>保留原有播放器、句子工作台与右侧字幕结构；仅承载私有原片和英文学习主路径，不使用静态兜底。</span>
      </div>
      <span className="v1-preview-scope">开发态验证 · 不代表 G4 已开放</span>
    </header>

    <div className="v1-mode-switch" role="group" aria-label="V1 学习模式">
      {modes.map((item) => <button
        key={item.id}
        type="button"
        className={mode === item.id ? 'active' : ''}
        aria-pressed={mode === item.id}
        disabled={!ready}
        onClick={() => setMode(item.id)}
      ><small>{item.eyebrow}</small><strong>{item.label}</strong><span>{item.description}</span></button>)}
    </div>

    <div className="v1-learning-layout">
      <div className="v1-video-column">
        <div className="v1-player-frame">
          {ready && playbackUrl
            ? <video
              ref={videoRef}
              src={playbackUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={`${asset.title} V1 学习界面原片`}
              onLoadedMetadata={(event) => { event.currentTarget.playbackRate = speed; updateFromVideo(event.currentTarget) }}
              onTimeUpdate={(event) => updateFromVideo(event.currentTarget)}
              onSeeked={(event) => updateFromVideo(event.currentTarget)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => { setPlaying(false); setActiveCueIndex(null) }}
            />
            : <PreviewStatus playback={playback} transcript={transcript} onVerifyPlayback={onVerifyPlayback} onVerifyTranscript={onVerifyTranscript}/>} 

          {ready && playbackUrl && <div className="v1-player-identity"><span>PRIVATE ORIGINAL</span><strong>{formatMediaDuration(asset.durationMs)}</strong></div>}
          {ready && mode !== 'listen' && activeCue && <div className={`v1-player-caption${mode === 'shadow' ? ' shadow' : ''}`} aria-live="off">
            <CueText cue={activeCue} mode={mode} positionMs={positionMs}/>
          </div>}
          {ready && mode === 'listen' && <div className="v1-listen-indicator"><Icon name="volume" size={18}/><span>精听模式：字幕已隐藏</span></div>}
        </div>

        <div className="v1-player-controls" aria-label="原片句子控制">
          <button type="button" disabled={!ready} onClick={cycleSpeed}><strong>{speed}x</strong><span>倍速</span></button>
          <button type="button" disabled={!ready || selectedCueIndex === 0} onClick={() => seekToCue(selectedCueIndex - 1)}><Icon name="chevronLeft"/><span>上一句</span></button>
          <button type="button" className="primary" disabled={!ready} onClick={togglePlayback}><Icon name={playing ? 'pause' : 'play'}/><span>{playing ? '暂停' : '播放'}</span></button>
          <button type="button" disabled={!ready || selectedCueIndex >= cues.length - 1} onClick={() => seekToCue(selectedCueIndex + 1)}><span>下一句</span><Icon name="chevronRight"/></button>
          <button type="button" className={loopCueIndex !== null ? 'active' : ''} aria-pressed={loopCueIndex !== null} disabled={!ready} onClick={toggleLoop}><Icon name="repeat"/><span>单句循环</span></button>
        </div>

        <div className="v1-sentence-workbench">
          <div className="v1-workbench-meta"><span>{modeCopy.eyebrow} MODE</span><time>{selectedCue ? formatCueTimestamp(selectedCue.startMs) : '--:--'}</time></div>
          {ready && selectedCue
            ? mode === 'listen'
              ? <div className="v1-listen-prompt"><Icon name="volume" size={28}/><strong>先听，再切回“观看”核对</strong><span>字幕文本不会在精听模式中泄露。</span></div>
              : <><p className="v1-focus-sentence"><CueText cue={selectedCue} mode={mode} positionMs={positionMs}/></p><span className="v1-focus-note">{mode === 'shadow' ? '按原片节奏开口模仿；本阶段不保存录音或学习进度。' : '字幕由真实视频时钟驱动；点击右侧句子可定位。'}</span></>
            : <><p className="v1-focus-sentence locked">等待真实原片与完整英文字幕</p><span className="v1-focus-note">当前仅展示兼容 V1 的界面骨架，不生成静态学习内容。</span></>}
        </div>
      </div>

      <aside className="v1-transcript-panel" aria-label="V1 英文字幕面板">
        <header>
          <div><p>ACTIVE ENGLISH ONLY</p><h4>完整英文字幕</h4></div>
          <span data-ready={activeTranscript ? 'true' : 'false'}><i/>{transcriptState}</span>
        </header>
        {ready && activeTranscript
          ? mode === 'listen'
            ? <div className="v1-transcript-hidden"><Icon name="volume" size={34}/><strong>字幕已隐藏</strong><p>回到“观看”或“跟读”后，才显示 ACTIVE 英文 Cue。</p></div>
            : <>
              <div className="v1-transcript-summary"><span>{activeTranscript.cueCount} 句 · 版本 {activeTranscript.version}</span><small>当前窗口 {visible.start + 1}–{visible.start + visible.cues.length}</small></div>
              <ol className="v1-cue-list" ref={cueListRef}>
                {visible.cues.map((cue, localIndex) => {
                  const index = visible.start + localIndex
                  return <li key={cue.id} data-cue-index={index} className={index === activeCueIndex ? 'current' : index === selectedCueIndex ? 'selected' : ''}>
                    <button type="button" onClick={() => seekToCue(index)} aria-current={index === activeCueIndex ? 'true' : undefined}>
                      <span className="v1-cue-index">{cue.order + 1}</span>
                      <span className="v1-cue-copy"><time>{formatCueTimestamp(cue.startMs)}</time><strong>{cue.text}</strong></span>
                    </button>
                  </li>
                })}
              </ol>
            </>
          : <TranscriptGate playback={playback} transcript={transcript} onVerifyTranscript={onVerifyTranscript}/>} 
      </aside>
    </div>

    <footer className="v1-preview-boundary"><i/><span>本页只验证“旧 UI 能否承载当前 V1 的真实原片与 ACTIVE 英文字幕”。录音持久化、学习进度和正式入口仍属于 G4。</span></footer>
  </section>
}
