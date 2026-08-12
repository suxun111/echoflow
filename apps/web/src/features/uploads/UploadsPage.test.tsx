import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UploadSessionView } from '@online-learning/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadsPage } from './UploadsPage'

const mocks = vi.hoisted(() => ({
  inspectUploadFile: vi.fn(), fingerprintFile: vi.fn(), getUploadManifest: vi.fn(),
  saveUploadManifest: vi.fn(), removeUploadManifest: vi.fn(), uploadMultipart: vi.fn(),
}))

vi.mock('../../lib/uploadManifest', () => ({
  inspectUploadFile: mocks.inspectUploadFile,
  fingerprintFile: mocks.fingerprintFile,
  getUploadManifest: mocks.getUploadManifest,
  saveUploadManifest: mocks.saveUploadManifest,
  removeUploadManifest: mocks.removeUploadManifest,
  manifestFromSession: (file: File, session: UploadSessionView) => ({
    fileFingerprint: session.fileFingerprint, uploadId: session.id, fileName: file.name,
    sizeBytes: file.size, lastModified: file.lastModified, expiresAt: session.expiresAt,
    parts: session.parts, updatedAt: new Date().toISOString(),
  }),
}))
vi.mock('./uploadRuntime', () => ({ uploadMultipart: mocks.uploadMultipart }))

const fingerprint = 'f'.repeat(64)
const session: UploadSessionView = {
  id: 'c8a31820-3984-4a95-9bc5-5d57410bb73d', status: 'uploading', originalName: 'podcast.mp4', title: 'Podcast',
  contentType: 'video/mp4', sizeBytes: 11, fileFingerprint: fingerprint, partSizeBytes: 5,
  partCount: 3, expiresAt: new Date(Date.now() + 60_000).toISOString(), completedAt: null,
  uploadedBytes: 5, parts: [{ partNumber: 1, sizeBytes: 5, etag: 'etag-1', completedAt: new Date().toISOString() }],
  mediaAssetId: null,
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
}

function selectPodcast() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(11)], 'podcast.mp4', { type: 'video/mp4', lastModified: 42 })] } })
}

describe('G2 upload page recovery behavior', () => {
  beforeEach(() => {
    mocks.inspectUploadFile.mockReset().mockResolvedValue({ durationMs: 60_000, width: 1280, height: 720 })
    mocks.fingerprintFile.mockReset().mockResolvedValue(fingerprint)
    mocks.getUploadManifest.mockReset().mockResolvedValue(undefined)
    mocks.saveUploadManifest.mockReset().mockResolvedValue(undefined)
    mocks.removeUploadManifest.mockReset().mockResolvedValue(undefined)
    mocks.uploadMultipart.mockReset()
    setOnline(true)
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('automatically pauses on offline and resumes only missing parts after online returns', async () => {
    const api = {
      fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/uploads' && !init?.method) return { items: [] }
        if (path === '/media-assets') return { items: [] }
        if (path === '/uploads' && init?.method === 'POST') return session
        if (path === `/uploads/${session.id}`) return session
        throw new Error(`unexpected ${path}`)
      }),
    }
    mocks.uploadMultipart
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')), { once: true })
      }))
      .mockResolvedValueOnce({ upload: { ...session, status: 'completed' }, mediaAssetId: crypto.randomUUID() })

    render(<UploadsPage api={api as never}/>)
    await screen.findByText('还没有视频')
    selectPodcast()
    await screen.findByText('podcast.mp4')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '开始私人上传' }))
    await waitFor(() => expect(mocks.uploadMultipart).toHaveBeenCalledTimes(1))

    setOnline(false)
    fireEvent(window, new Event('offline'))
    expect(await screen.findByText('网络已断开，上传已自动暂停。')).toBeInTheDocument()
    setOnline(true)
    fireEvent(window, new Event('online'))

    await waitFor(() => expect(mocks.uploadMultipart).toHaveBeenCalledTimes(2))
    expect(mocks.uploadMultipart.mock.calls[1][0].session.parts).toEqual(session.parts)
  })

  it('reselects the same file after refresh and reuses the server session without creating another upload', async () => {
    const api = {
      fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/uploads' && !init?.method) return { items: [session] }
        if (path === '/media-assets') return { items: [] }
        if (path === `/uploads/${session.id}`) return session
        throw new Error(`unexpected ${path}`)
      }),
    }
    mocks.getUploadManifest.mockResolvedValue({ uploadId: session.id, parts: session.parts })
    mocks.uploadMultipart.mockResolvedValue({ upload: { ...session, status: 'completed' }, mediaAssetId: crypto.randomUUID() })

    render(<UploadsPage api={api as never}/>)
    await screen.findByText('1 条私人记录')
    selectPodcast()
    expect(await screen.findByText(/已找到续传清单/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '继续缺失分片' }))

    await waitFor(() => expect(mocks.uploadMultipart).toHaveBeenCalledOnce())
    expect(api.fetchJson).not.toHaveBeenCalledWith('/uploads', expect.objectContaining({ method: 'POST' }))
    expect(mocks.uploadMultipart.mock.calls[0][0].session).toMatchObject({ id: session.id, parts: session.parts })
  })

  it('cancels the provider upload and removes its local recovery manifest', async () => {
    const api = {
      fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/uploads' && !init?.method) return { items: [session] }
        if (path === '/media-assets') return { items: [] }
        if (path === `/uploads/${session.id}/cancel` && init?.method === 'POST') return { cancelled: true }
        throw new Error(`unexpected ${path}`)
      }),
    }
    render(<UploadsPage api={api as never}/>)
    await screen.findByText('1 条私人记录')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(api.fetchJson).toHaveBeenCalledWith(`/uploads/${session.id}/cancel`, { method: 'POST' }))
    expect(mocks.removeUploadManifest).toHaveBeenCalledWith(fingerprint)
  })

  it('retries complete after a lost success response and accepts the same completed asset', async () => {
    const verifying = { ...session, status: 'verifying' as const, uploadedBytes: 11, parts: [
      session.parts[0],
      { partNumber: 2, sizeBytes: 5, etag: 'etag-2', completedAt: new Date().toISOString() },
      { partNumber: 3, sizeBytes: 1, etag: 'etag-3', completedAt: new Date().toISOString() },
    ] }
    const completed = { ...verifying, status: 'completed' as const, completedAt: new Date().toISOString(), mediaAssetId: crypto.randomUUID() }
    let completeAttempts = 0
    let providerCommitted = false
    const api = {
      fetchJson: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/uploads' && !init?.method) return { items: [providerCommitted ? completed : verifying] }
        if (path === '/media-assets') return { items: [] }
        if (path === `/uploads/${session.id}`) return providerCommitted ? completed : verifying
        if (path === `/uploads/${session.id}/complete` && init?.method === 'POST') {
          completeAttempts += 1
          if (completeAttempts === 1) { providerCommitted = true; throw new Error('响应在服务端提交后丢失') }
          return { upload: completed, mediaAssetId: completed.mediaAssetId }
        }
        throw new Error(`unexpected ${path}`)
      }),
    }
    render(<UploadsPage api={api as never}/>)
    await screen.findByText('1 条私人记录')
    selectPodcast()
    await screen.findByText('podcast.mp4')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '继续缺失分片' }))
    await screen.findByText('响应在服务端提交后丢失')
    fireEvent.click(screen.getByRole('button', { name: '继续缺失分片' }))

    await waitFor(() => expect(completeAttempts).toBe(2))
    expect(mocks.uploadMultipart).not.toHaveBeenCalled()
    expect(mocks.removeUploadManifest).toHaveBeenCalledWith(fingerprint)
  })
})
