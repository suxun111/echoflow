import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getUploadManifest, inspectUploadFile, removeUploadManifest, saveUploadManifest,
  type UploadManifest,
} from './uploadManifest'

type RequestHandler = ((event: Event) => void) | null

class MemoryRequest<T = unknown> {
  result!: T
  error: DOMException | null = null
  onsuccess: RequestHandler = null
  onerror: RequestHandler = null
  onupgradeneeded: RequestHandler = null
}

function createMemoryIndexedDb() {
  const records = new Map<string, UploadManifest>()
  let initialized = false
  const request = <T>(operation: () => T) => {
    const pending = new MemoryRequest<T>()
    queueMicrotask(() => {
      try {
        pending.result = operation()
        pending.onsuccess?.(new Event('success'))
      } catch (error) {
        pending.error = error instanceof DOMException ? error : new DOMException('IndexedDB operation failed')
        pending.onerror?.(new Event('error'))
      }
    })
    return pending
  }
  const database = {
    close: vi.fn(),
    createObjectStore: vi.fn(),
    transaction: () => ({
      objectStore: () => ({
        put: (manifest: UploadManifest) => request(() => { records.set(manifest.fileFingerprint, structuredClone(manifest)) }),
        get: (fingerprint: string) => request(() => {
          const manifest = records.get(fingerprint)
          return manifest ? structuredClone(manifest) : undefined
        }),
        delete: (fingerprint: string) => request(() => { records.delete(fingerprint) }),
      }),
    }),
  }
  return {
    open: () => {
      const pending = new MemoryRequest<typeof database>()
      queueMicrotask(() => {
        pending.result = database
        if (!initialized) {
          initialized = true
          pending.onupgradeneeded?.(new Event('upgradeneeded'))
        }
        pending.onsuccess?.(new Event('success'))
      })
      return pending
    },
  } as unknown as IDBFactory
}

describe('G2 local upload manifest', () => {
  const nativeCreateObjectUrl = URL.createObjectURL
  const nativeRevokeObjectUrl = URL.revokeObjectURL

  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: createMemoryIndexedDb() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: nativeCreateObjectUrl },
      revokeObjectURL: { configurable: true, value: nativeRevokeObjectUrl },
    })
  })

  it('persists, restores and removes only the resumable manifest in IndexedDB', async () => {
    const manifest: UploadManifest = {
      fileFingerprint: 'a'.repeat(64), uploadId: crypto.randomUUID(), fileName: 'podcast.mp4',
      sizeBytes: 123, lastModified: 456, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      parts: [{ partNumber: 1, sizeBytes: 100, etag: 'etag-1', completedAt: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    }
    await saveUploadManifest(manifest)
    await expect(getUploadManifest(manifest.fileFingerprint)).resolves.toEqual(manifest)
    await removeUploadManifest(manifest.fileFingerprint)
    await expect(getUploadManifest(manifest.fileFingerprint)).resolves.toBeUndefined()
  })

  it('accepts exactly sixty minutes and releases the temporary media Object URL after metadata succeeds', async () => {
    const video = document.createElement('video')
    const nativeCreateElement = document.createElement.bind(document)
    Object.defineProperties(video, {
      duration: { configurable: true, value: 60 * 60 },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
      load: { configurable: true, value: vi.fn() },
    })
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => (
      tagName === 'video' ? video : nativeCreateElement(tagName, options)
    ))
    const createUrl = vi.fn(() => 'blob:echoflow-test')
    const revokeUrl = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createUrl },
      revokeObjectURL: { configurable: true, value: revokeUrl },
    })
    const inspecting = inspectUploadFile(new File([new Uint8Array([1])], 'podcast.mp4', { type: 'video/mp4' }))
    video.onloadedmetadata?.(new Event('loadedmetadata'))

    await expect(inspecting).resolves.toEqual({ durationMs: 3_600_000, width: 1920, height: 1080 })
    expect(createUrl).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:echoflow-test')
    expect(video.getAttribute('src')).toBeNull()
  })

  it('rejects extension, MIME, empty and 8 GiB boundaries before allocating an Object URL', async () => {
    const createUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
    const cases = [
      new File([new Uint8Array([1])], 'podcast.mov', { type: 'video/mp4' }),
      new File([new Uint8Array([1])], 'podcast.mp4', { type: 'video/quicktime' }),
      new File([], 'empty.mp4', { type: 'video/mp4' }),
    ]
    for (const file of cases) await expect(inspectUploadFile(file)).rejects.toThrow()
    const oversized = new File([new Uint8Array([1])], 'huge.mp4', { type: 'video/mp4' })
    Object.defineProperty(oversized, 'size', { value: 8 * 1024 ** 3 + 1 })
    await expect(inspectUploadFile(oversized)).rejects.toThrow('8 GiB')
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('rejects media just beyond sixty minutes and still releases its Object URL', async () => {
    const video = document.createElement('video')
    const nativeCreateElement = document.createElement.bind(document)
    Object.defineProperties(video, {
      duration: { configurable: true, value: 60 * 60 + 0.001 },
      videoWidth: { configurable: true, value: 1920 }, videoHeight: { configurable: true, value: 1080 },
      load: { configurable: true, value: vi.fn() },
    })
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => (
      tagName === 'video' ? video : nativeCreateElement(tagName, options)
    ))
    const revokeUrl = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: () => 'blob:echoflow-too-long' },
      revokeObjectURL: { configurable: true, value: revokeUrl },
    })
    const inspecting = inspectUploadFile(new File([new Uint8Array([1])], 'long.mp4', { type: 'video/mp4' }))
    video.onloadedmetadata?.(new Event('loadedmetadata'))
    await expect(inspecting).rejects.toThrow('60 分钟')
    expect(revokeUrl).toHaveBeenCalledWith('blob:echoflow-too-long')
  })

  it('also releases the temporary media Object URL when metadata loading fails', async () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'load', { configurable: true, value: vi.fn() })
    const nativeCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => (
      tagName === 'video' ? video : nativeCreateElement(tagName, options)
    ))
    const revokeUrl = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: () => 'blob:echoflow-error' },
      revokeObjectURL: { configurable: true, value: revokeUrl },
    })
    const inspecting = inspectUploadFile(new File([new Uint8Array([1])], 'broken.mp4', { type: 'video/mp4' }))
    video.onerror?.(new Event('error'))

    await expect(inspecting).rejects.toThrow('浏览器无法读取该 MP4')
    expect(revokeUrl).toHaveBeenCalledWith('blob:echoflow-error')
  })
})
