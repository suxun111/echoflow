import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

type PlayerControls = { playSegment: (start: number, end: number, loop: boolean) => void; pause: () => void }
type Props = { videoId: string; onError: (message: string) => void }

declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }

let apiPromise: Promise<void> | null = null
function loadApi() {
  if (window.YT?.Player) return Promise.resolve()
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.onerror = () => resolve()
    window.onYouTubeIframeAPIReady = () => resolve()
    document.head.appendChild(script)
  })
  return apiPromise
}

export const YouTubePlayer = forwardRef<PlayerControls, Props>(({ videoId, onError }, ref) => {
  const holder = useRef<HTMLDivElement>(null)
  const player = useRef<any>(null)
  const interval = useRef<number | null>(null)
  const segment = useRef<{ start: number; end: number; loop: boolean } | null>(null)
  const onErrorRef = useRef(onError)
  const [ready, setReady] = useState(false)

  const clearSegmentTimer = useCallback(() => {
    if (interval.current !== null) window.clearInterval(interval.current)
    interval.current = null
  }, [])

  useEffect(() => { onErrorRef.current = onError }, [onError])

  useEffect(() => {
    let disposed = false
    setReady(false)
    loadApi().then(() => {
      if (disposed) return
      if (!window.YT?.Player || !holder.current) { onErrorRef.current('YouTube 播放器加载失败，请检查网络后重试。'); return }
      player.current = new window.YT.Player(holder.current, {
        videoId,
        playerVars: { rel: 0, playsinline: 1 },
        events: {
          onReady: () => { if (!disposed) setReady(true) },
          onError: (event: { data: number }) => { if (!disposed) onErrorRef.current(`该视频无法嵌入播放（YouTube 错误代码 ${event.data}）。你仍可使用字幕练习。`) },
        },
      })
    })
    return () => {
      disposed = true
      clearSegmentTimer()
      segment.current = null
      player.current?.destroy?.()
      player.current = null
    }
  }, [clearSegmentTimer, videoId])

  useImperativeHandle(ref, () => ({
    playSegment(start, end, loop) {
      if (!ready || !player.current) return
      segment.current = { start, end, loop }
      player.current.seekTo(start, true)
      player.current.playVideo()
      clearSegmentTimer()
      interval.current = window.setInterval(() => {
        const active = segment.current
        if (!active || !player.current) { clearSegmentTimer(); return }
        if (player.current.getCurrentTime() < active.end) return
        if (active.loop) { player.current.seekTo(active.start, true); player.current.playVideo() }
        else { player.current.pauseVideo(); segment.current = null; clearSegmentTimer() }
      }, 250)
    },
    pause() {
      player.current?.pauseVideo?.()
      segment.current = null
      clearSegmentTimer()
    },
  }), [clearSegmentTimer, ready])

  return <div className="player-shell"><div ref={holder} className="youtube-player" />{!ready && <span className="player-loading">正在连接 YouTube…</span>}</div>
})
