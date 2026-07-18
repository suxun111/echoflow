import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecorder } from './useRecorder'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = () => true

  mimeType = 'audio/webm;codecs=opus'
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this)
  }

  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.onstop?.(new Event('stop'))
  }
}

describe('useRecorder', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = []
  })

  it('stops the active recorder and microphone tracks on unmount', async () => {
    const stopTrack = vi.fn()
    const mediaStream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(mediaStream) },
    })
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    })
    const onComplete = vi.fn(async () => undefined)
    const { result, unmount } = renderHook(() => useRecorder(onComplete))

    await act(async () => { await result.current.start() })
    expect(result.current.isRecording).toBe(true)

    const activeRecorder = FakeMediaRecorder.instances[0]
    unmount()

    expect(activeRecorder.state).toBe('inactive')
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('ignores a second start while microphone permission is pending', async () => {
    const stopTrack = vi.fn()
    const mediaStream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    let resolveStream: (value: MediaStream) => void = () => undefined
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve }))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    })
    const { result, unmount } = renderHook(() => useRecorder(vi.fn(async () => undefined)))

    await act(async () => {
      const firstStart = result.current.start()
      const secondStart = result.current.start()
      resolveStream(mediaStream)
      await Promise.all([firstStart, secondStart])
    })

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    unmount()
    expect(stopTrack).toHaveBeenCalledOnce()
  })
})
