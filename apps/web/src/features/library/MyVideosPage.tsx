import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveTranscriptView, MediaAssetView } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import { ApiClientError, type ApiClient } from '../../lib/apiClient'
import { parseActiveTranscriptView } from './activeTranscript'
import { describeTranscript, formatCueTimestamp, formatMediaDuration } from './mediaStatus'

type TranscriptPanel = {
  asset: MediaAssetView
  kind: 'loading' | 'ready' | 'not-ready' | 'error'
  value?: ActiveTranscriptView
  message?: string
}

const transcriptPreviewLimit = 12

export function MyVideosPage({ api, search, onUpload }: { api: ApiClient; search: string; onUpload: () => void }) {
  const [assets, setAssets] = useState<MediaAssetView[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [playback, setPlayback] = useState<{ asset: MediaAssetView; url: string } | null>(null)
  const [transcript, setTranscript] = useState<TranscriptPanel | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const playbackHeadingRef = useRef<HTMLHeadingElement>(null)
  const transcriptHeadingRef = useRef<HTMLHeadingElement>(null)
  const playbackTriggerRef = useRef<HTMLButtonElement | null>(null)
  const transcriptTriggerRef = useRef<HTMLButtonElement | null>(null)
  const resumeTime = useRef(0)
  const playbackRefreshes = useRef(0)
  const retryKeys = useRef<Record<string, string>>({})
  const transcriptRequestVersion = useRef(0)

  const loadAssets = useCallback(async () => {
    setLoadError('')
    try {
      const response = await api.fetchJson<{ items: MediaAssetView[] }>('/media-assets')
      setAssets(response.items)
    } catch {
      setLoadError('无法读取私人媒体。请确认本机服务正常后重新读取。')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void loadAssets() }, [loadAssets])
  useEffect(() => {
    if (!assets.some((asset) => asset.status === 'processing_playback'
      || ['queued', 'processing', 'validating'].includes(asset.transcriptProcessing?.status ?? ''))) return
    const timer = window.setInterval(() => void loadAssets(), 2_500)
    return () => window.clearInterval(timer)
  }, [assets, loadAssets])

  useEffect(() => { if (playback) playbackHeadingRef.current?.focus() }, [playback])
  useEffect(() => { if (transcript) transcriptHeadingRef.current?.focus() }, [transcript])

  const restoreFocus = useCallback((target: HTMLButtonElement | null) => {
    window.setTimeout(() => target?.focus(), 0)
  }, [])

  const closePlayback = useCallback(() => {
    setPlayback(null)
    restoreFocus(playbackTriggerRef.current)
  }, [restoreFocus])

  const closeTranscript = useCallback(() => {
    transcriptRequestVersion.current += 1
    setTranscript(null)
    restoreFocus(transcriptTriggerRef.current)
  }, [restoreFocus])

  const closeDetails = useCallback(() => {
    const focusTarget = transcript ? transcriptTriggerRef.current : playbackTriggerRef.current
    transcriptRequestVersion.current += 1
    setPlayback(null)
    setTranscript(null)
    restoreFocus(focusTarget)
  }, [restoreFocus, transcript])

  useEffect(() => {
    if (!playback && !transcript) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDetails()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeDetails, playback, transcript])

  const filtered = useMemo(() => assets.filter((asset) => asset.title.toLowerCase().includes(search.trim().toLowerCase())), [assets, search])

  async function openPlayback(asset: MediaAssetView, preserveTime = true, trigger?: HTMLButtonElement) {
    if (trigger) playbackTriggerRef.current = trigger
    if (preserveTime && videoRef.current) resumeTime.current = videoRef.current.currentTime
    setActionError('')
    try {
      const response = await api.fetchJson<{ playbackUrl: string }>(`/media-assets/${asset.id}/playback-url`, { method: 'POST' })
      setPlayback({ asset, url: response.playbackUrl })
    } catch {
      setActionError('暂时无法签发原片播放地址，请稍后重试。')
    }
  }

  async function openTranscript(asset: MediaAssetView, trigger?: HTMLButtonElement) {
    if (trigger) transcriptTriggerRef.current = trigger
    const requestVersion = ++transcriptRequestVersion.current
    setActionError('')
    setTranscript({ asset, kind: 'loading' })
    try {
      const value = parseActiveTranscriptView(await api.fetchJson<unknown>(`/media-assets/${asset.id}/transcript`))
      if (value.mediaAssetId !== asset.id) throw new Error('字幕与当前媒体不匹配')
      if (requestVersion !== transcriptRequestVersion.current) return
      setTranscript({ asset, kind: 'ready', value })
    } catch (reason) {
      if (requestVersion !== transcriptRequestVersion.current) return
      if (reason instanceof ApiClientError && reason.status === 409 && reason.body.code === 'transcript_not_ready') {
        setTranscript({ asset, kind: 'not-ready' })
      } else {
        setTranscript({ asset, kind: 'error', message: '暂时无法读取完整英文字幕，请稍后重试。' })
      }
    }
  }

  async function retryTranscript(asset: MediaAssetView) {
    const storageKey = `echoflow:transcript-retry:${asset.id}`
    const idempotencyKey = retryKeys.current[asset.id]
      ?? window.sessionStorage.getItem(storageKey)
      ?? `web-${crypto.randomUUID()}`
    retryKeys.current[asset.id] = idempotencyKey
    window.sessionStorage.setItem(storageKey, idempotencyKey)
    setActionError('')
    try {
      await api.fetchJson(`/media-assets/${asset.id}/transcript/retry`, {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
      })
      delete retryKeys.current[asset.id]
      window.sessionStorage.removeItem(storageKey)
      await loadAssets()
    } catch {
      setActionError('字幕暂时无法重新处理，请稍后再试。')
    }
  }

  const visibleTranscriptCues = transcript?.kind === 'ready'
    ? transcript.value!.cues.slice(0, transcriptPreviewLimit)
    : []

  return <main className="my-videos-page" aria-busy={loading}>
    <header className="private-library-heading"><div><p>MY PRIVATE VIDEOS</p><h1>我的视频</h1><span>这里只显示当前账号真实上传的媒体资产。</span></div><button onClick={onUpload}><Icon name="upload" size={16}/>上传新视频</button></header>
    {actionError && <p className="upload-error" role="alert">{actionError}</p>}
    {loading ? <div className="private-library-empty" role="status">正在读取私人媒体…</div>
      : loadError ? <section className="private-library-empty private-library-error" role="alert"><h2>暂时无法读取媒体</h2><p>{loadError}</p><button onClick={() => void loadAssets()}>重新读取</button></section>
        : filtered.length === 0 ? <section className="private-library-empty"><span className="drop-wave"><i/><i/><i/><i/><i/></span><h2>{search ? '没有匹配的视频' : '从一段真正想练的英语开始'}</h2><p>{search ? '换一个标题关键词，或清空搜索。' : '上传后先验证原片播放；完整英文字幕准备好后才会显示。'}</p>{!search && <button onClick={onUpload}>上传第一段视频</button>}</section>
          : <section className="private-media-grid">
            {filtered.map((asset) => {
              const copy = describeTranscript(asset)
              const originalLabel = asset.status === 'playable' ? copy.label : asset.status === 'failed' ? '原片不可播放' : '正在检查原片'
              return <article key={asset.id}>
                <div className="private-media-cover"><span className="drop-wave"><i/><i/><i/><i/><i/></span><small>{asset.status === 'playable' ? 'PRIVATE MEDIA READY' : asset.status === 'failed' ? 'MEDIA UNAVAILABLE' : 'CHECKING MEDIA'}</small></div>
                <div className="private-media-copy"><span data-tone={asset.status === 'playable' ? copy.tone : 'failed'}>{originalLabel}</span><h2>{asset.title}</h2><p>{asset.originalName} · {asset.status === 'failed' ? '请上传 MP4 / H.264 / AAC 文件' : formatMediaDuration(asset.durationMs)}</p>{asset.status === 'playable' && <p className="transcript-status-copy">{copy.detail}</p>}<div className="private-media-actions">{asset.status === 'playable' ? <button onClick={(event) => { playbackRefreshes.current = 0; void openPlayback(asset, false, event.currentTarget) }}><Icon name="play" size={14}/>播放原片</button> : <button onClick={onUpload}>查看处理任务</button>}{copy.canCheck && <button onClick={(event) => void openTranscript(asset, event.currentTarget)}>检查英文字幕</button>}{copy.retryable && <button onClick={() => void retryTranscript(asset)}>重试字幕</button>}</div></div>
              </article>
            })}
          </section>}
    {playback && <section className="playback-sheet" aria-labelledby="playback-sheet-title"><div className="playback-heading"><div><p>ORIGINAL QUALITY</p><h2 id="playback-sheet-title" ref={playbackHeadingRef} tabIndex={-1}>{playback.asset.title}</h2></div><button onClick={closePlayback} aria-label="关闭播放器"><Icon name="close"/></button></div><video ref={videoRef} controls src={playback.url} onLoadedMetadata={() => { if (videoRef.current && resumeTime.current) { videoRef.current.currentTime = resumeTime.current; resumeTime.current = 0 } }} onError={() => { if (playbackRefreshes.current < 1) { playbackRefreshes.current += 1; void openPlayback(playback.asset) } else setActionError('播放地址刷新后仍不可用，请稍后重试') }}/></section>}
    {transcript && <section className="transcript-sheet transcript-sheet-proof" aria-labelledby="transcript-sheet-title" aria-busy={transcript.kind === 'loading'}><div className="playback-heading transcript-proof-heading"><div><p>COMPLETE ENGLISH TRANSCRIPT</p><h2 id="transcript-sheet-title" ref={transcriptHeadingRef} tabIndex={-1}>{transcript.asset.title}</h2>{transcript.kind === 'ready' && <span>{transcript.value!.cueCount} 句 · 已确认完整英文字幕</span>}</div><button onClick={closeTranscript} aria-label="关闭字幕"><Icon name="close"/></button></div>{transcript.kind === 'loading' ? <p className="transcript-panel-message" role="status">正在确认是否存在唯一完整英文字幕…</p> : transcript.kind === 'not-ready' ? <p className="transcript-panel-message">完整英文字幕尚未准备好；不会显示部分字幕。</p> : transcript.kind === 'error' ? <p className="transcript-panel-message" role="alert">{transcript.message}</p> : <><p className="transcript-proof-note"><i/>完整英文字幕已确认。此处为只读核验样本，显示前 {visibleTranscriptCues.length} 句（共 {transcript.value!.cueCount} 句）；学习、循环和录音会在后续能力通过后开放。</p><ol className="transcript-proof-list" aria-label="完整英文字幕核验样本">{visibleTranscriptCues.map((cue) => <li key={cue.id}><span className="transcript-proof-index">{cue.order + 1}</span><div><time>{formatCueTimestamp(cue.startMs)}</time><p>{cue.text}</p></div></li>)}</ol></>}</section>}
  </main>
}
