import { useCallback, useEffect, useRef, useState } from 'react'

export function useRecorder(onComplete: (blob: Blob, mimeType: string) => Promise<void>) {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const starting = useRef(false)
  const mounted = useRef(true)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])

  const stopTracks = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      starting.current = false
      const activeRecorder = recorder.current
      if (activeRecorder && activeRecorder.state !== 'inactive') {
        activeRecorder.ondataavailable = null
        activeRecorder.onstop = null
        activeRecorder.stop()
      }
      recorder.current = null
      stopTracks()
    }
  }, [stopTracks])

  const start = useCallback(async () => {
    if (starting.current || recorder.current) return
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('当前浏览器不支持录音。请使用最新版 Chrome、Edge 或 Safari。')
      return
    }
    starting.current = true
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        mediaStream.getTracks().forEach((track) => track.stop())
        return
      }
      stream.current = mediaStream
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      const instance = new MediaRecorder(stream.current, preferred ? { mimeType: preferred } : undefined)
      const chunks: BlobPart[] = []
      instance.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      instance.onstop = async () => {
        recorder.current = null
        stopTracks()
        if (!mounted.current) return
        setIsRecording(false)
        const mimeType = instance.mimeType || 'audio/webm'
        try { await onCompleteRef.current(new Blob(chunks, { type: mimeType }), mimeType) }
        catch { if (mounted.current) setError('录音未能保存到本机，请检查浏览器存储空间。') }
      }
      recorder.current = instance
      instance.start()
      setIsRecording(true)
    } catch (cause) {
      stopTracks()
      recorder.current = null
      if (mounted.current) setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? '未获得麦克风权限。你仍可继续不录音练习。' : '无法启动录音，请检查麦克风是否被其他应用占用。')
    } finally {
      starting.current = false
    }
  }, [stopTracks])

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  return { isRecording, error, start, stop }
}
