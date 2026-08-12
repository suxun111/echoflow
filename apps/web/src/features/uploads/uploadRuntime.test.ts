import type { UploadSessionView } from '@online-learning/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadMultipart } from './uploadRuntime'

class FakeUploadTarget { onprogress: ((event: ProgressEvent) => void) | null = null }

class FakeXMLHttpRequest {
  static sent: Array<{ url: string; size: number }> = []
  static statuses: number[] = []
  upload = new FakeUploadTarget()
  status = 200
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  onload: (() => void) | null = null
  private url = ''
  private aborted = false

  open(_method: string, url: string) { this.url = url }
  getResponseHeader(name: string) { return name.toLowerCase() === 'etag' ? `etag-${this.url.split('/').pop()}` : null }
  abort() { this.aborted = true; this.onabort?.() }
  send(blob: Blob) {
    FakeXMLHttpRequest.sent.push({ url: this.url, size: blob.size })
    queueMicrotask(() => {
      if (this.aborted) return
      this.status = FakeXMLHttpRequest.statuses.shift() ?? 200
      this.upload.onprogress?.({ loaded: blob.size } as ProgressEvent)
      this.onload?.()
    })
  }
}

const baseSession: UploadSessionView = {
  id: crypto.randomUUID(), status: 'uploading', originalName: 'podcast.mp4', title: 'Podcast',
  contentType: 'video/mp4', sizeBytes: 11, fileFingerprint: 'a'.repeat(64), partSizeBytes: 5,
  partCount: 3, expiresAt: new Date(Date.now() + 60_000).toISOString(), completedAt: null,
  uploadedBytes: 5, parts: [{ partNumber: 1, sizeBytes: 5, etag: 'etag-1', completedAt: new Date().toISOString() }],
  mediaAssetId: null,
}

describe('G2 browser multipart runtime', () => {
  beforeEach(() => {
    FakeXMLHttpRequest.sent = []
    FakeXMLHttpRequest.statuses = []
    Object.defineProperty(window, 'XMLHttpRequest', { configurable: true, value: FakeXMLHttpRequest })
  })

  it('uploads only missing slices, records ETags and completes after all parts', async () => {
    const calls: string[] = []
    const api = {
      fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
        calls.push(path)
        if (path.endsWith('/parts/sign')) {
          const body = JSON.parse(String(init?.body)) as { partNumbers: number[] }
          return { parts: body.partNumbers.map((partNumber) => ({ partNumber, uploadUrl: `https://storage.test/${partNumber}` })) }
        }
        if (path.endsWith('/complete')) return { upload: { ...baseSession, status: 'completed' }, mediaAssetId: crypto.randomUUID() }
        const partNumber = Number(path.split('/').pop())
        return { partNumber, sizeBytes: partNumber === 3 ? 1 : 5, etag: `etag-${partNumber}` }
      }),
    }
    const parts: number[] = []
    const progress: number[] = []
    const states: string[] = []
    const file = new File([new Uint8Array(11)], 'podcast.mp4', { type: 'video/mp4' })
    const result = await uploadMultipart({
      api: api as never,
      file,
      session: baseSession,
      signal: new AbortController().signal,
      concurrency: 1,
      onProgress: (bytes) => progress.push(bytes),
      onVerifying: () => states.push('verifying'),
      onPart: (part) => { parts.push(part.partNumber) },
    })
    expect(FakeXMLHttpRequest.sent.map(({ size }) => size)).toEqual([5, 1])
    expect(parts).toEqual([2, 3])
    expect(progress.at(-1)).toBe(11)
    expect(calls.at(-1)).toBe(`/uploads/${baseSession.id}/complete`)
    expect(states).toEqual(['verifying'])
    expect(result.upload.status).toBe('completed')
  })

  it('does not issue part URLs when the upload is already paused', async () => {
    const controller = new AbortController()
    controller.abort()
    const api = { fetchJson: vi.fn() }
    await expect(uploadMultipart({
      api: api as never,
      file: new File([new Uint8Array(11)], 'podcast.mp4', { type: 'video/mp4' }),
      session: baseSession,
      signal: controller.signal,
      onProgress: () => undefined,
      onPart: () => undefined,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.fetchJson).not.toHaveBeenCalled()
  })

  it('refreshes only the missing part signature after a 403 from object storage', async () => {
    FakeXMLHttpRequest.statuses = [403, 200]
    const resumable = {
      ...baseSession,
      uploadedBytes: 10,
      parts: [
        baseSession.parts[0],
        { partNumber: 2, sizeBytes: 5, etag: 'etag-2', completedAt: new Date().toISOString() },
      ],
    }
    let signed = 0
    let recorded = 0
    const api = {
      fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/parts/sign')) {
          signed += 1
          const body = JSON.parse(String(init?.body)) as { partNumbers: number[] }
          return { parts: body.partNumbers.map((partNumber) => ({ partNumber, uploadUrl: `https://storage.test/${partNumber}?attempt=${signed}` })) }
        }
        if (path.endsWith('/complete')) return { upload: { ...resumable, status: 'completed' }, mediaAssetId: crypto.randomUUID() }
        recorded += 1
        return { partNumber: 3, sizeBytes: 1, etag: 'etag-3' }
      }),
    }
    await uploadMultipart({
      api: api as never,
      file: new File([new Uint8Array(11)], 'podcast.mp4', { type: 'video/mp4' }),
      session: resumable,
      signal: new AbortController().signal,
      concurrency: 3,
      onProgress: () => undefined,
      onPart: () => undefined,
    })
    expect(signed).toBe(2)
    expect(recorded).toBe(1)
    expect(FakeXMLHttpRequest.sent).toHaveLength(2)
  })
})
