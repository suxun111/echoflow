import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MediaAssetView, UploadPartView, UploadSessionView } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import type { ApiClient } from '../../lib/apiClient'
import {
  fingerprintFile, getUploadManifest, inspectUploadFile, manifestFromSession,
  removeUploadManifest, saveUploadManifest, type LocalVideoInfo,
} from '../../lib/uploadManifest'
import { uploadMultipart } from './uploadRuntime'

type UploadPhase = 'idle' | 'checking' | 'ready' | 'uploading' | 'paused' | 'offline' | 'verifying' | 'done'

const ACTIVE = new Set(['created', 'uploading', 'verifying'])

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

function formatDuration(durationMs: number | null) {
  if (!durationMs) return '等待媒体检查'
  const totalMinutes = Math.round(durationMs / 60_000)
  if (totalMinutes < 1) return '不足 1 分钟'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

function statusCopy(upload: UploadSessionView, asset?: MediaAssetView) {
  if (upload.status === 'cancelled') return ['已取消', '原始分片已撤销']
  if (upload.status === 'expired') return ['已过期', '7 天续传窗口已经结束']
  if (upload.status === 'failed' || asset?.status === 'failed') return ['不支持播放', asset?.errorCode === 'media_format_unsupported' ? '请重新上传 MP4 / H.264 / AAC 文件' : '对象或媒体检查失败，请重新上传原文件']
  if (asset?.status === 'playable'
    && asset.transcriptProcessing?.status === 'succeeded'
    && asset.transcriptProcessing.stage === 'transcript_ready') return ['字幕已完成', '完整英文逐词字幕已经准备好']
  if (asset?.status === 'playable' && asset.transcriptProcessing?.status === 'failed') return ['字幕失败，原片可播', asset.transcriptProcessing.errorCode ?? '字幕任务失败，请在“我的视频”中重试']
  if (asset?.status === 'playable' && ['queued', 'processing', 'validating'].includes(asset.transcriptProcessing?.status ?? '')) {
    const state = asset.transcriptProcessing!
    return ['正在生成字幕', state.totalChunks ? `已完成 ${state.completedChunks}/${state.totalChunks} 个分片` : '正在提取并切分英文音频']
  }
  if (asset?.status === 'playable') return ['可以播放', '原始清晰度视频已经准备好，等待字幕任务']
  if (upload.status === 'completed') return ['检查播放', '正在确认容器、编码和真实时长']
  if (upload.status === 'verifying') return ['核对文件', '正在读取对象存储的真实分片清单']
  if (upload.status === 'uploading') return ['上传中', '可以暂停，并在 7 天内继续']
  return ['等待上传', '选择同一份原文件即可继续']
}

export function UploadsPage({ api }: { api: ApiClient }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const playerRef = useRef<HTMLVideoElement>(null)
  const resumeTimeRef = useRef(0)
  const playbackRefreshesRef = useRef(0)
  const [uploads, setUploads] = useState<UploadSessionView[]>([])
  const [assets, setAssets] = useState<MediaAssetView[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [fileInfo, setFileInfo] = useState<LocalVideoInfo | null>(null)
  const [fingerprint, setFingerprint] = useState('')
  const [title, setTitle] = useState('')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [phase, setPhase] = useState<UploadPhase>('idle')
  const [uploadedBytes, setUploadedBytes] = useState(0)
  const [activeSession, setActiveSession] = useState<UploadSessionView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [playback, setPlayback] = useState<{ asset: MediaAssetView; url: string } | null>(null)

  const loadData = useCallback(async () => {
    try {
      const [uploadResponse, assetResponse] = await Promise.all([
        api.fetchJson<{ items: UploadSessionView[] }>('/uploads'),
        api.fetchJson<{ items: MediaAssetView[] }>('/media-assets'),
      ])
      setUploads(uploadResponse.items)
      setAssets(assetResponse.items)
      if (activeSession) {
        const current = uploadResponse.items.find((item) => item.id === activeSession.id)
        if (current) { setActiveSession(current); setUploadedBytes(current.uploadedBytes) }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载上传任务')
    } finally {
      setLoading(false)
    }
  }, [api, activeSession?.id])

  useEffect(() => { void loadData() }, [loadData])
  useEffect(() => {
    if (!assets.some((asset) => asset.status === 'processing_playback'
      || ['queued', 'processing', 'validating'].includes(asset.transcriptProcessing?.status ?? ''))) return
    const timer = window.setInterval(() => void loadData(), 2_500)
    return () => window.clearInterval(timer)
  }, [assets, loadData])
  useEffect(() => () => abortRef.current?.abort(), [])

  const assetByUpload = useMemo(() => new Map(assets.map((asset) => [asset.uploadSessionId, asset])), [assets])
  const activeUpload = uploads.find((upload) => ACTIVE.has(upload.status)) ?? null
  const progress = file ? Math.min(100, Math.round(uploadedBytes / file.size * 100)) : activeSession ? Math.round(activeSession.uploadedBytes / activeSession.sizeBytes * 100) : 0

  async function selectFile(selected: File) {
    abortRef.current?.abort()
    setError('')
    setNotice('')
    setPhase('checking')
    try {
      const [info, identity] = await Promise.all([inspectUploadFile(selected), fingerprintFile(selected)])
      const manifest = await getUploadManifest(identity).catch(() => undefined)
      const serverSession = uploads.find((upload) => ACTIVE.has(upload.status) && upload.fileFingerprint === identity)
      if (activeUpload && activeUpload.fileFingerprint !== identity) throw new Error('当前已有另一份未完成上传。请先继续或取消它。')
      setFile(selected)
      setFileInfo(info)
      setFingerprint(identity)
      setTitle(selected.name.replace(/\.mp4$/i, '').slice(0, 300))
      setActiveSession(serverSession ?? null)
      setUploadedBytes(serverSession?.uploadedBytes ?? 0)
      setPhase('ready')
      if (serverSession || manifest) setNotice(`已找到续传清单，将从 ${serverSession?.parts.length ?? manifest?.parts.length ?? 0} 个已完成分片之后继续。`)
    } catch (reason) {
      setFile(null)
      setFileInfo(null)
      setFingerprint('')
      setPhase('idle')
      setError(reason instanceof Error ? reason.message : '无法读取所选文件')
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    if (selected) void selectFile(selected)
    event.target.value = ''
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    const selected = event.dataTransfer.files[0]
    if (selected) void selectFile(selected)
  }

  const startUpload = useCallback(async () => {
    if (!file || !fingerprint || !rightsConfirmed) return
    setError('')
    setNotice('')
    let session = activeSession
    try {
      if (!session) {
        session = await api.fetchJson<UploadSessionView>('/uploads', {
          method: 'POST',
          body: JSON.stringify({
            fileName: file.name, contentType: 'video/mp4', sizeBytes: file.size,
            fileFingerprint: fingerprint, rightsConfirmed: true, title,
          }),
        })
        setActiveSession(session)
      }
      session = await api.fetchJson<UploadSessionView>(`/uploads/${session.id}`)
      setActiveSession(session)
      setUploadedBytes(session.uploadedBytes)
      await saveUploadManifest(manifestFromSession(file, session)).catch(() => undefined)
      const controller = new AbortController()
      abortRef.current = controller
      let result: { upload: UploadSessionView; mediaAssetId: string }
      if (session.status === 'completed' && session.mediaAssetId) {
        result = { upload: session, mediaAssetId: session.mediaAssetId }
      } else if (session.status === 'verifying') {
        setPhase('verifying')
        result = await api.fetchJson(`/uploads/${session.id}/complete`, { method: 'POST' })
      } else {
        setPhase('uploading')
        const parts = new Map(session.parts.map((part) => [part.partNumber, part]))
        result = await uploadMultipart({
          api, file, session, signal: controller.signal, concurrency: 3,
          onProgress: setUploadedBytes,
          onVerifying: () => setPhase('verifying'),
          onPart: async (part: UploadPartView) => {
            parts.set(part.partNumber, part)
            session = { ...session!, parts: Array.from(parts.values()), uploadedBytes: Array.from(parts.values()).reduce((sum, value) => sum + value.sizeBytes, 0) }
            setActiveSession(session)
            await saveUploadManifest(manifestFromSession(file, session)).catch(() => undefined)
          },
        })
      }
      setActiveSession(result.upload)
      await removeUploadManifest(fingerprint).catch(() => undefined)
      await loadData()
      setPhase('done')
      setNotice('上传已完整保存，正在检查视频是否可直接播放。')
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setPhase(navigator.onLine ? 'paused' : 'offline')
        return
      }
      if (!navigator.onLine) setPhase('offline')
      else setPhase('paused')
      setError(reason instanceof Error ? reason.message : '上传中断，请继续上传')
    } finally {
      abortRef.current = null
    }
  }, [activeSession, api, file, fingerprint, loadData, rightsConfirmed, title])

  useEffect(() => {
    const goOffline = () => {
      if (phase === 'uploading') { abortRef.current?.abort(); setPhase('offline'); setNotice('网络已断开，上传已自动暂停。') }
    }
    const goOnline = () => {
      if (phase === 'offline' && file) { setNotice('网络已恢复，正在继续缺失分片。'); void startUpload() }
    }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => { window.removeEventListener('offline', goOffline); window.removeEventListener('online', goOnline) }
  }, [file, phase, startUpload])

  function pauseUpload() { abortRef.current?.abort(); setPhase('paused'); setNotice('上传已暂停。当前分片不会计入完成进度。') }

  async function cancelUpload(upload: UploadSessionView) {
    abortRef.current?.abort()
    setError('')
    try {
      await api.fetchJson(`/uploads/${upload.id}/cancel`, { method: 'POST' })
      if (upload.fileFingerprint) await removeUploadManifest(upload.fileFingerprint).catch(() => undefined)
      setFile(null); setFileInfo(null); setFingerprint(''); setActiveSession(null); setPhase('idle'); setUploadedBytes(0)
      await loadData()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法取消上传') }
  }

  const refreshPlayback = useCallback(async (asset: MediaAssetView, preserveTime = true) => {
    if (preserveTime && playerRef.current) resumeTimeRef.current = playerRef.current.currentTime
    try {
      const response = await api.fetchJson<{ playbackUrl: string }>(`/media-assets/${asset.id}/playback-url`, { method: 'POST' })
      setPlayback({ asset, url: response.playbackUrl })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法播放该视频')
    }
  }, [api])

  return <main className="uploads-page">
    <header className="upload-hero">
      <div><p className="upload-eyebrow">YOUR PRIVATE SOURCE</p><h1>把长视频送进你的<br/><em>影子练习流。</em></h1></div>
      <p>原片直接进入私人对象存储，不经过应用服务器。中断后 7 天内选择同一文件，就从缺失的分片继续。</p>
      <div className="journey-rail" aria-label="视频处理步骤"><span className="active">选择原片</span><i/><span>私人直传</span><i/><span>播放检查</span><i/><span className="future">完整字幕 · G3</span></div>
    </header>

    <section className="upload-workspace">
      <div className="upload-composer">
        <div className="composer-heading"><span>01</span><div><h2>选择一份英语视频</h2><p>MP4 · H.264 · AAC，最长 3 小时，单文件不超过 8 GiB</p></div></div>
        <input ref={inputRef} hidden type="file" accept="video/mp4,.mp4" onChange={onFileChange}/>
        {!file ? <button className={`file-drop ${phase === 'checking' ? 'checking' : ''}`} onClick={() => inputRef.current?.click()} onDrop={onDrop} onDragOver={(event) => event.preventDefault()} disabled={phase === 'checking'}>
          <span className="drop-wave"><i/><i/><i/><i/><i/></span>
          <strong>{phase === 'checking' ? '正在读取文件…' : activeUpload ? '选择原文件继续上传' : '拖放视频，或从电脑选择'}</strong>
          <small>浏览器只读取媒体信息和首尾样本，不把整份文件存进本地数据库</small>
        </button> : <div className="selected-file">
          <div className="file-glyph"><Icon name="play" size={22}/></div>
          <div><strong>{file.name}</strong><p>{formatBytes(file.size)} · {formatDuration(fileInfo?.durationMs ?? null)} · {fileInfo?.width}×{fileInfo?.height}</p></div>
          <button onClick={() => inputRef.current?.click()} disabled={phase === 'uploading'}>更换</button>
        </div>}

        {file && <div className="upload-fields">
          <label>视频标题<input value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)}/></label>
          <label className="rights-confirm"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)}/><span><strong>我确认拥有处理该视频的权利</strong><small>视频和后续字幕仅当前账号可见；请勿上传无权处理的内容。</small></span></label>
        </div>}

        {(phase === 'uploading' || phase === 'paused' || phase === 'offline' || phase === 'verifying' || phase === 'done') && <div className="live-progress">
          <div><span>{phase === 'uploading' ? '正在上传' : phase === 'paused' ? '已暂停' : phase === 'offline' ? '等待网络' : phase === 'verifying' ? '正在核对' : '上传完成'}</span><strong>{progress}%</strong></div>
          <div className="progress-track"><i style={{ width: `${progress}%` }}/></div>
          <small>{formatBytes(uploadedBytes)} / {formatBytes(file?.size ?? activeSession?.sizeBytes ?? 0)} · 已完成分片会保留到 {activeSession ? new Date(activeSession.expiresAt).toLocaleDateString('zh-CN') : '7 天后'}</small>
        </div>}

        {notice && <p className="upload-notice">{notice}</p>}
        {error && <p className="upload-error" role="alert">{error}</p>}
        <div className="upload-actions">
          {phase === 'uploading' ? <button className="secondary" onClick={pauseUpload}><Icon name="pause" size={16}/>暂停上传</button> : null}
          {(phase === 'ready' || phase === 'paused' || phase === 'offline') && <button className="primary" disabled={!rightsConfirmed || !title.trim()} onClick={() => void startUpload()}><Icon name="upload" size={16}/>{activeSession ? '继续缺失分片' : '开始私人上传'}</button>}
          {activeSession && ACTIVE.has(activeSession.status) && phase !== 'uploading' && <button className="danger-text" onClick={() => void cancelUpload(activeSession)}>取消并清理分片</button>}
        </div>
      </div>

      <aside className="upload-trust">
        <div className="trust-lock">PRIVATE</div><h2>字节走最短的路。</h2><p>文件直接从你的浏览器进入私有对象存储。EchoFlow API 只保存分片清单、文件身份和处理状态。</p>
        <dl><div><dt>32 MiB</dt><dd>默认分片</dd></div><div><dt>3</dt><dd>并行上传</dd></div><div><dt>7 天</dt><dd>续传窗口</dd></div><div><dt>15 分钟</dt><dd>签名有效期</dd></div></dl>
      </aside>
    </section>

    <section className="upload-ledger">
      <div className="ledger-heading"><div><p>UPLOAD LEDGER</p><h2>上传与播放任务</h2></div><span>{uploads.length} 条私人记录</span></div>
      {loading ? <div className="ledger-empty">正在读取真实任务…</div> : uploads.length === 0 ? <div className="ledger-empty"><strong>还没有视频</strong><p>选择第一段你真正想反复听、反复说的英语内容。</p></div> : <div className="task-list">
        {uploads.map((upload) => {
          const asset = assetByUpload.get(upload.id)
          const [label, detail] = statusCopy(upload, asset)
          const percent = Math.round(upload.uploadedBytes / upload.sizeBytes * 100)
          return <article className={`upload-task status-${asset?.status ?? upload.status}`} key={upload.id}>
            <div className="task-index">{String(uploads.length - uploads.indexOf(upload)).padStart(2, '0')}</div>
            <div className="task-main"><div className="task-title"><span>{label}</span><h3>{upload.title}</h3><p>{upload.originalName} · {formatBytes(upload.sizeBytes)} · {asset ? formatDuration(asset.durationMs) : `${upload.parts.length}/${upload.partCount} 分片`}</p></div>
              <div className="task-meter"><i style={{ width: `${asset?.status === 'playable' ? 100 : percent}%` }}/></div><small>{detail}</small></div>
            <div className="task-buttons">
              {asset?.status === 'playable' && <button onClick={() => { playbackRefreshesRef.current = 0; void refreshPlayback(asset, false) }}><Icon name="play" size={15}/>播放原片</button>}
              {ACTIVE.has(upload.status) && <button onClick={() => inputRef.current?.click()}>选择原文件继续</button>}
              {ACTIVE.has(upload.status) && <button className="quiet-danger" onClick={() => void cancelUpload(upload)}>取消</button>}
            </div>
          </article>
        })}
      </div>}
    </section>

    {playback && <section className="playback-sheet" aria-label="原片播放验证">
      <div className="playback-heading"><div><p>ORIGINAL QUALITY</p><h2>{playback.asset.title}</h2><span>签名过期时会刷新地址并保留当前位置。</span></div><button onClick={() => setPlayback(null)} aria-label="关闭播放器"><Icon name="close"/></button></div>
      <video ref={playerRef} controls src={playback.url} onLoadedMetadata={() => { if (playerRef.current && resumeTimeRef.current) { playerRef.current.currentTime = resumeTimeRef.current; resumeTimeRef.current = 0 } }} onError={() => { if (playbackRefreshesRef.current < 1) { playbackRefreshesRef.current += 1; void refreshPlayback(playback.asset) } else setError('播放地址刷新后仍不可用，请稍后重试') }}/>
      <p>字幕和影子练习尚未开放。本页只验证 G2 的真实私人媒体与 Range 播放。</p>
    </section>}
  </main>
}
