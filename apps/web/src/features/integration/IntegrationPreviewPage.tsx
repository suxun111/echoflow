import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveTranscriptView, MediaAssetView, PlaybackUrl } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import { ApiClientError, type ApiClient } from '../../lib/apiClient'
import { parseActiveTranscriptView } from '../library/activeTranscript'
import { describeTranscript, formatCueTimestamp, formatMediaDuration } from '../library/mediaStatus'
import '../../styles/v1-learning-preview.css'
import {
  V1LearningPreview,
  type V1PreviewPlaybackState,
  type V1PreviewTranscriptState,
} from './V1LearningPreview'

const cuePreviewLimit = 12

function parsePlaybackUrl(value: unknown): PlaybackUrl {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_playback_url')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.mediaAssetId !== 'string' || candidate.mediaAssetId.length === 0) throw new Error('invalid_playback_url')
  if (typeof candidate.playbackUrl !== 'string' || candidate.playbackUrl.length === 0) throw new Error('invalid_playback_url')
  if (typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt))) throw new Error('invalid_playback_url')
  try {
    new URL(candidate.playbackUrl)
  } catch {
    throw new Error('invalid_playback_url')
  }
  return { mediaAssetId: candidate.mediaAssetId, playbackUrl: candidate.playbackUrl, expiresAt: candidate.expiresAt }
}

export function IntegrationPreviewPage({ api, onReturnToLibrary }: { api: ApiClient; onReturnToLibrary: () => void }) {
  const [assets, setAssets] = useState<MediaAssetView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [playback, setPlayback] = useState<V1PreviewPlaybackState>({ kind: 'idle' })
  const [transcript, setTranscript] = useState<V1PreviewTranscriptState>({ kind: 'idle' })
  const selectedIdRef = useRef<string | null>(null)
  const requestVersions = useRef({ list: 0, playback: 0, transcript: 0 })

  const clearVerification = useCallback(() => {
    requestVersions.current.playback += 1
    requestVersions.current.transcript += 1
    setPlayback({ kind: 'idle' })
    setTranscript({ kind: 'idle' })
  }, [])

  const loadAssets = useCallback(async () => {
    const requestVersion = ++requestVersions.current.list
    clearVerification()
    setLoading(true)
    setLoadError('')
    try {
      const response = await api.fetchJson<{ items: MediaAssetView[] }>('/media-assets')
      if (requestVersion !== requestVersions.current.list) return
      setAssets(response.items)
      const nextSelectedId = response.items.some((asset) => asset.id === selectedIdRef.current)
        ? selectedIdRef.current
        : response.items[0]?.id ?? null
      selectedIdRef.current = nextSelectedId
      setSelectedId(nextSelectedId)
    } catch {
      if (requestVersion === requestVersions.current.list) setLoadError('无法读取当前账号的媒体状态。请确认本机服务已启动后重试。')
    } finally {
      if (requestVersion === requestVersions.current.list) setLoading(false)
    }
  }, [api, clearVerification])

  useEffect(() => { void loadAssets() }, [loadAssets])

  const selected = useMemo(() => assets.find((asset) => asset.id === selectedId) ?? null, [assets, selectedId])
  const transcriptCopy = selected ? describeTranscript(selected) : null
  const playbackForSelected: V1PreviewPlaybackState = !selected || playback.kind === 'idle' || playback.assetId !== selected.id
    ? { kind: 'idle' }
    : playback
  const transcriptForSelected: V1PreviewTranscriptState = !selected || transcript.kind === 'idle' || transcript.assetId !== selected.id
    ? { kind: 'idle' }
    : transcript
  const activeTranscript = transcriptForSelected.kind === 'ready' ? transcriptForSelected.value : null
  const visibleCues = activeTranscript?.cues.slice(0, cuePreviewLimit) ?? []

  function selectAsset(asset: MediaAssetView) {
    if (asset.id === selectedIdRef.current) return
    clearVerification()
    selectedIdRef.current = asset.id
    setSelectedId(asset.id)
  }

  async function verifyPlayback() {
    if (!selected || selected.status !== 'playable') return
    const assetId = selected.id
    const requestVersion = ++requestVersions.current.playback
    setPlayback({ kind: 'loading', assetId })
    try {
      const response = parsePlaybackUrl(await api.fetchJson<unknown>(`/media-assets/${assetId}/playback-url`, { method: 'POST' }))
      if (response.mediaAssetId !== assetId) throw new Error('播放地址与当前媒体不匹配')
      if (requestVersion !== requestVersions.current.playback || selectedIdRef.current !== assetId) return
      setPlayback({ kind: 'ready', assetId, url: response.playbackUrl })
    } catch {
      if (requestVersion === requestVersions.current.playback && selectedIdRef.current === assetId) {
        setPlayback({ kind: 'error', assetId, message: '暂时无法签发原片播放地址。请稍后重新验证。' })
      }
    }
  }

  async function verifyTranscript() {
    if (!selected || selected.status !== 'playable') return
    const assetId = selected.id
    const requestVersion = ++requestVersions.current.transcript
    setTranscript({ kind: 'loading', assetId })
    try {
      const value = parseActiveTranscriptView(await api.fetchJson<unknown>(`/media-assets/${assetId}/transcript`))
      if (value.mediaAssetId !== assetId) throw new Error('字幕与当前媒体不匹配')
      if (requestVersion !== requestVersions.current.transcript || selectedIdRef.current !== assetId) return
      setTranscript({ kind: 'ready', assetId, value })
    } catch (reason) {
      if (requestVersion !== requestVersions.current.transcript || selectedIdRef.current !== assetId) return
      if (reason instanceof ApiClientError && reason.status === 409 && reason.body.code === 'transcript_not_ready') {
        setTranscript({ kind: 'not-ready', assetId })
      } else {
        setTranscript({ kind: 'error', assetId, message: '暂时无法读取完整英文字幕。请稍后重新验证。' })
      }
    }
  }

  return <main className="integration-preview-page">
    <header className="integration-preview-heading">
      <div>
        <p>DEVELOPMENT VERIFICATION</p>
        <h1>V1 学习界面验证台</h1>
        <span>用旧版学习框架承载当前账号的真实原片与 ACTIVE 英文字幕；不会启动转写或修改媒体。</span>
      </div>
      <div className="integration-preview-heading-actions">
        <button className="quiet-action" onClick={onReturnToLibrary}><Icon name="chevronLeft" size={16}/>返回我的视频</button>
        <button className="primary-action" onClick={() => void loadAssets()}>刷新状态</button>
      </div>
    </header>

    {loading ? <section className="integration-empty" role="status">正在读取当前账号的媒体状态…</section>
      : loadError ? <section className="integration-empty integration-error" role="alert"><h2>暂时无法读取媒体</h2><p>{loadError}</p><button onClick={() => void loadAssets()}>重新读取</button></section>
        : assets.length === 0 ? <section className="integration-empty"><span className="drop-wave"><i/><i/><i/><i/><i/></span><h2>还没有可核验的媒体</h2><p>先从“上传与处理”完成一次真实上传，再回到这里检查原片与英文字幕状态。</p><button onClick={onReturnToLibrary}>前往我的视频</button></section>
          : <section className="integration-preview-layout" aria-busy={loading}>
            <aside className="verification-source-list" aria-label="当前账号的媒体">
              <div className="verification-source-heading"><p>PRIVATE MEDIA</p><h2>选择一段媒体</h2><span>{assets.length} 条当前账号记录</span></div>
              <div className="verification-asset-list">
                {assets.map((asset) => {
                  const copy = describeTranscript(asset)
                  return <button key={asset.id} className={asset.id === selectedId ? 'selected' : ''} aria-pressed={asset.id === selectedId} onClick={() => selectAsset(asset)}>
                    <span className="verification-asset-wave"><i/><i/><i/></span>
                    <span><strong>{asset.title}</strong><small>{asset.status === 'playable' ? copy.label : asset.status === 'failed' ? '原片不可播放' : '正在检查原片'}</small></span>
                  </button>
                })}
              </div>
              <p className="verification-privacy-note">此页不显示对象键、内部任务标识或模型版本。</p>
            </aside>

            {selected && transcriptCopy && <section className="verification-workbench">
              <header className="verification-summary">
                <div><p>SELECTED PRIVATE MEDIA</p><h2>{selected.title}</h2><span>{selected.originalName} · {formatMediaDuration(selected.durationMs)}</span></div>
                <div className="verification-state-rail" aria-label="真实处理状态">
                  <span data-state={selected.status === 'playable' ? 'ready' : selected.status === 'failed' ? 'failed' : 'pending'}><i/>原片</span>
                  <span data-state={transcriptCopy.tone}><i/>英文字幕</span>
                </div>
              </header>

              <V1LearningPreview
                key={selected.id}
                asset={selected}
                playback={playbackForSelected}
                transcript={transcriptForSelected}
                onVerifyPlayback={() => void verifyPlayback()}
                onVerifyTranscript={() => void verifyTranscript()}
              />

              <div className="verification-detail-heading"><p>BACKEND VERIFICATION DETAIL</p><h3>接口核验明细</h3><span>用于分开检查播放地址与 ACTIVE 字幕响应。</span></div>
              <div className="verification-panels">
                <section className="verification-player-panel" aria-labelledby="verification-player-title">
                  <div className="verification-panel-heading"><div><p>ORIGINAL PLAYBACK</p><h3 id="verification-player-title">原片播放</h3></div><span>{selected.status === 'playable' ? '可验证' : '等待原片检查'}</span></div>
                  {selected.status !== 'playable' ? <div className="verification-panel-empty"><p>原片尚未准备好播放。请等待媒体检查完成后再验证。</p></div>
                    : playbackForSelected.kind === 'ready' ? <video controls src={playbackForSelected.url} aria-label={`${selected.title} 原片播放`}/>
                      : <div className="verification-panel-empty">{playbackForSelected.kind === 'loading' ? <p role="status">正在签发原片播放地址…</p> : playbackForSelected.kind === 'error' ? <><p role="alert">{playbackForSelected.message}</p><button onClick={() => void verifyPlayback()}>重新验证播放</button></> : <><p>播放地址只会在你点击验证后签发。</p><button onClick={() => void verifyPlayback()}><Icon name="play" size={15}/>验证原片播放</button></>}</div>}
                </section>

                <section className="verification-transcript-panel" aria-labelledby="verification-transcript-title">
                  <div className="verification-panel-heading"><div><p>ACTIVE ENGLISH TRANSCRIPT</p><h3 id="verification-transcript-title">完整英文字幕</h3></div><span data-tone={transcriptForSelected.kind === 'ready' ? 'ready' : transcriptCopy.tone}>{transcriptForSelected.kind === 'ready' ? '已确认完整英文字幕' : transcriptCopy.label}</span></div>
                  {transcriptForSelected.kind === 'ready' ? <>
                    <p className="verification-cue-sample">接口已确认完整英文字幕；此处只读显示前 {Math.min(cuePreviewLimit, transcriptForSelected.value.cueCount)} 句（共 {transcriptForSelected.value.cueCount} 句）。</p>
                    <ol className="verification-cue-list" aria-label="英文字幕抽样">{visibleCues.map((cue) => <li key={cue.id}><time>{formatCueTimestamp(cue.startMs)}</time><p>{cue.text}</p></li>)}</ol>
                  </> : <div className="verification-panel-empty">
                    {transcriptForSelected.kind === 'loading' ? <p role="status">正在确认是否存在唯一完整英文字幕…</p>
                      : transcriptForSelected.kind === 'not-ready' ? <p>完整英文字幕尚未准备好；不会显示部分字幕。</p>
                        : transcriptForSelected.kind === 'error' ? <><p role="alert">{transcriptForSelected.message}</p><button onClick={() => void verifyTranscript()}>重新检查字幕</button></>
                          : <><p>{transcriptCopy.detail}</p>{selected.status === 'playable' && <button onClick={() => void verifyTranscript()}>检查完整英文字幕</button>}</>}
                  </div>}
                </section>
              </div>

            </section>}
          </section>}
  </main>
}
