import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MediaAssetView } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import type { ApiClient } from '../../lib/apiClient'

function durationLabel(durationMs: number | null) {
  if (!durationMs) return '等待播放检查'
  const minutes = Math.round(durationMs / 60_000)
  if (minutes < 1) return '不足 1 分钟'
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
}

export function MyVideosPage({ api, search, onUpload }: { api: ApiClient; search: string; onUpload: () => void }) {
  const [assets, setAssets] = useState<MediaAssetView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [playback, setPlayback] = useState<{ asset: MediaAssetView; url: string } | null>(null)
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
    if (!assets.some((asset) => asset.status === 'processing_playback')) return
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

  return <main className="my-videos-page">
    <header className="private-library-heading"><div><p>MY PRIVATE VIDEOS</p><h1>我的视频</h1><span>这里只显示当前账号真实上传的媒体资产。</span></div><button onClick={onUpload}><Icon name="upload" size={16}/>上传新视频</button></header>
    {error && <p className="upload-error" role="alert">{error}</p>}
    {loading ? <div className="private-library-empty">正在读取私人媒体…</div> : filtered.length === 0 ? <section className="private-library-empty"><span className="drop-wave"><i/><i/><i/><i/><i/></span><h2>{search ? '没有匹配的视频' : '从一段真正想练的英语开始'}</h2><p>{search ? '换一个标题关键词，或清空搜索。' : '上传后先验证原始清晰度播放；完整英文字幕将在 G3 接入。'}</p>{!search && <button onClick={onUpload}>上传第一段视频</button>}</section> : <section className="private-media-grid">
      {filtered.map((asset) => <article key={asset.id}>
        <div className="private-media-cover"><span className="drop-wave"><i/><i/><i/><i/><i/></span><small>{asset.status === 'playable' ? 'READY TO PLAY' : 'CHECKING MEDIA'}</small></div>
        <div className="private-media-copy"><span>{asset.status === 'playable' ? '可以播放' : asset.status === 'failed' ? '不支持播放' : '正在检查'}</span><h2>{asset.title}</h2><p>{asset.originalName} · {asset.status === 'failed' ? '请上传 MP4 / H.264 / AAC 文件' : durationLabel(asset.durationMs)}</p>{asset.status === 'playable' ? <button onClick={() => { playbackRefreshes.current = 0; void openPlayback(asset, false) }}><Icon name="play" size={14}/>播放原片</button> : <button onClick={onUpload}>查看处理任务</button>}</div>
      </article>)}
    </section>}
    {playback && <section className="playback-sheet"><div className="playback-heading"><div><p>ORIGINAL QUALITY</p><h2>{playback.asset.title}</h2></div><button onClick={() => setPlayback(null)} aria-label="关闭播放器"><Icon name="close"/></button></div><video ref={videoRef} controls src={playback.url} onLoadedMetadata={() => { if (videoRef.current && resumeTime.current) { videoRef.current.currentTime = resumeTime.current; resumeTime.current = 0 } }} onError={() => { if (playbackRefreshes.current < 1) { playbackRefreshes.current += 1; void openPlayback(playback.asset) } else setError('播放地址刷新后仍不可用，请稍后重试') }}/></section>}
  </main>
}
