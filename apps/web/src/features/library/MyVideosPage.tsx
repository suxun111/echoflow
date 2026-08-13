import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveTranscriptView, MediaAssetView } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import type { ApiClient } from '../../lib/apiClient'

function durationLabel(durationMs: number | null) {
  if (!durationMs) return '等待播放检查'
  const minutes = Math.round(durationMs / 60_000)
  if (minutes < 1) return '不足 1 分钟'
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
}

const stageCopy: Record<string, string> = {
  playback_ready: '等待提取音频', audio_extracting: '正在提取 16 kHz 英文音频', chunking: '正在切分长音频',
  transcribing: 'MOSS 正在生成逐词时间戳', merging: '正在合并分片', cue_segmenting: '正在整理句子',
  validating: '正在校验完整性', transcript_ready: '完整英文字幕已准备好',
}

function transcriptCopy(asset: MediaAssetView) {
  const state = asset.transcriptProcessing
  if (!state) return { tone: 'waiting', label: '等待字幕任务', detail: '原片可播放，字幕链尚未启动' }
  if (state.status === 'succeeded' && state.stage === 'transcript_ready') {
    return { tone: 'ready', label: '字幕已准备', detail: '完整英文逐词字幕已经原子发布' }
  }
  if (state.status === 'failed' || state.status === 'cancelled') {
    return { tone: 'failed', label: '字幕生成失败', detail: `原片仍可播放 · ${state.errorCode ?? '请稍后重试'}` }
  }
  const chunks = state.totalChunks ? ` · ${state.completedChunks}/${state.totalChunks} 个分片` : ''
  return { tone: 'processing', label: '正在生成字幕', detail: `${stageCopy[state.stage ?? ''] ?? '正在准备字幕'}${chunks}` }
}

export function MyVideosPage({ api, search, onUpload }: { api: ApiClient; search: string; onUpload: () => void }) {
  const [assets, setAssets] = useState<MediaAssetView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playback, setPlayback] = useState<{ asset: MediaAssetView; url: string } | null>(null)
  const [transcript, setTranscript] = useState<{ asset: MediaAssetView; value: ActiveTranscriptView } | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const resumeTime = useRef(0)
  const playbackRefreshes = useRef(0)

  const loadAssets = useCallback(async () => {
    await api.fetchJson<{ items: MediaAssetView[] }>('/media-assets')
      .then((response) => setAssets(response.items))
      .catch((reason) => setError(reason instanceof Error ? reason.message : '无法读取私人视频'))
      .finally(() => setLoading(false))
  }, [api])

  useEffect(() => { void loadAssets() }, [loadAssets])
  useEffect(() => {
    if (!assets.some((asset) => asset.status === 'processing_playback'
      || ['queued', 'processing', 'validating'].includes(asset.transcriptProcessing?.status ?? ''))) return
    const timer = window.setInterval(() => void loadAssets(), 2_500)
    return () => window.clearInterval(timer)
  }, [assets, loadAssets])

  const filtered = useMemo(() => assets.filter((asset) => asset.title.toLowerCase().includes(search.trim().toLowerCase())), [assets, search])

  async function openPlayback(asset: MediaAssetView, preserveTime = true) {
    if (preserveTime && videoRef.current) resumeTime.current = videoRef.current.currentTime
    try {
      const response = await api.fetchJson<{ playbackUrl: string }>(`/media-assets/${asset.id}/playback-url`, { method: 'POST' })
      setPlayback({ asset, url: response.playbackUrl })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法播放该视频') }
  }

  async function openTranscript(asset: MediaAssetView) {
    try {
      const value = await api.fetchJson<ActiveTranscriptView>(`/media-assets/${asset.id}/transcript`)
      setTranscript({ asset, value })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法读取完整字幕') }
  }

  async function retryTranscript(asset: MediaAssetView) {
    try {
      await api.fetchJson(`/media-assets/${asset.id}/transcript/retry`, {
        method: 'POST', headers: { 'Idempotency-Key': `web-${crypto.randomUUID()}` },
      })
      await loadAssets()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法重试字幕任务') }
  }

  return <main className="my-videos-page">
    <header className="private-library-heading"><div><p>MY PRIVATE VIDEOS</p><h1>我的视频</h1><span>这里只显示当前账号真实上传的媒体资产。</span></div><button onClick={onUpload}><Icon name="upload" size={16}/>上传新视频</button></header>
    {error && <p className="upload-error" role="alert">{error}</p>}
    {loading ? <div className="private-library-empty">正在读取私人媒体…</div> : filtered.length === 0 ? <section className="private-library-empty"><span className="drop-wave"><i/><i/><i/><i/><i/></span><h2>{search ? '没有匹配的视频' : '从一段真正想练的英语开始'}</h2><p>{search ? '换一个标题关键词，或清空搜索。' : '上传后先验证原始清晰度播放；完整英文字幕将在 G3 接入。'}</p>{!search && <button onClick={onUpload}>上传第一段视频</button>}</section> : <section className="private-media-grid">
      {filtered.map((asset) => { const copy = transcriptCopy(asset); return <article key={asset.id}>
        <div className="private-media-cover"><span className="drop-wave"><i/><i/><i/><i/><i/></span><small>{copy.tone === 'ready' ? 'TRANSCRIPT READY' : asset.status === 'playable' ? 'ORIGINAL PLAYABLE' : 'CHECKING MEDIA'}</small></div>
        <div className="private-media-copy"><span data-tone={copy.tone}>{asset.status === 'playable' ? copy.label : asset.status === 'failed' ? '不支持播放' : '正在检查原片'}</span><h2>{asset.title}</h2><p>{asset.originalName} · {asset.status === 'failed' ? '请上传 MP4 / H.264 / AAC 文件' : durationLabel(asset.durationMs)}</p>{asset.status === 'playable' && <p className="transcript-status-copy">{copy.detail}</p>}<div className="private-media-actions">{asset.status === 'playable' ? <button onClick={() => { playbackRefreshes.current = 0; void openPlayback(asset, false) }}><Icon name="play" size={14}/>播放原片</button> : <button onClick={onUpload}>查看处理任务</button>}{copy.tone === 'ready' && <button onClick={() => void openTranscript(asset)}>查看字幕</button>}{copy.tone === 'failed' && <button onClick={() => void retryTranscript(asset)}>重试字幕</button>}</div></div>
      </article> })}
    </section>}
    {playback && <section className="playback-sheet"><div className="playback-heading"><div><p>ORIGINAL QUALITY</p><h2>{playback.asset.title}</h2></div><button onClick={() => setPlayback(null)} aria-label="关闭播放器"><Icon name="close"/></button></div><video ref={videoRef} controls src={playback.url} onLoadedMetadata={() => { if (videoRef.current && resumeTime.current) { videoRef.current.currentTime = resumeTime.current; resumeTime.current = 0 } }} onError={() => { if (playbackRefreshes.current < 1) { playbackRefreshes.current += 1; void openPlayback(playback.asset) } else setError('播放地址刷新后仍不可用，请稍后重试') }}/></section>}
    {transcript && <section className="transcript-sheet"><div className="playback-heading"><div><p>COMPLETE ENGLISH TRANSCRIPT</p><h2>{transcript.asset.title}</h2><span>{transcript.value.cueCount} 句 · MOSS {transcript.value.modelVersion}</span></div><button onClick={() => setTranscript(null)} aria-label="关闭字幕"><Icon name="close"/></button></div><ol>{transcript.value.cues.map((cue) => <li key={cue.id}><time>{Math.floor(cue.startMs / 60_000)}:{String(Math.floor(cue.startMs / 1000) % 60).padStart(2, '0')}</time><p>{cue.text}</p></li>)}</ol></section>}
  </main>
}
