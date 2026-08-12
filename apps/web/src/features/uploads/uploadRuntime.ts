import type { UploadPartView, UploadSessionView } from '@online-learning/contracts'
import type { ApiClient } from '../../lib/apiClient'

class UploadTransportError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function putPart(url: string, blob: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    request.open('PUT', url)
    request.upload.onprogress = (event) => onProgress(event.loaded)
    request.onerror = () => { cleanup(); reject(new UploadTransportError(0, navigator.onLine ? '分片上传失败' : '网络已断开')) }
    request.onabort = () => { cleanup(); reject(new DOMException('上传已暂停', 'AbortError')) }
    request.onload = () => {
      cleanup()
      if (request.status < 200 || request.status >= 300) return reject(new UploadTransportError(request.status, '上传签名已失效或对象存储拒绝了分片'))
      const etag = request.getResponseHeader('etag')
      if (!etag) return reject(new UploadTransportError(request.status, '对象存储未返回 ETag，请检查 CORS 配置'))
      resolve(etag)
    }
    request.send(blob)
  })
}

export async function uploadMultipart(options: {
  api: ApiClient
  file: File
  session: UploadSessionView
  signal: AbortSignal
  concurrency?: number
  onProgress: (uploadedBytes: number) => void
  onPart: (part: UploadPartView) => Promise<void> | void
  onVerifying?: () => void
}) {
  const completed = new Map(options.session.parts.map((part) => [part.partNumber, part]))
  const inflight = new Map<number, number>()
  const signedUrls = new Map<number, string>()
  const missing = Array.from({ length: options.session.partCount }, (_, index) => index + 1)
    .filter((partNumber) => !completed.has(partNumber))
  let cursor = 0
  let signingPromise: Promise<void> | null = null

  const report = () => options.onProgress(
    Array.from(completed.values()).reduce((sum, part) => sum + part.sizeBytes, 0)
    + Array.from(inflight.values()).reduce((sum, loaded) => sum + loaded, 0),
  )
  report()

  async function signFor(partNumber: number, forceSingle = false) {
    if (!forceSingle && signedUrls.has(partNumber)) return signedUrls.get(partNumber)!
    if (forceSingle) signedUrls.delete(partNumber)
    while (!signedUrls.has(partNumber)) {
      let initiated = false
      if (!signingPromise) {
        initiated = true
        const batch = forceSingle
          ? [partNumber]
          : missing.filter((candidate) => !completed.has(candidate) && !signedUrls.has(candidate)).slice(0, 20)
        signingPromise = options.api.fetchJson<{ parts: Array<{ partNumber: number; uploadUrl: string }> }>(
          `/uploads/${options.session.id}/parts/sign`,
          { method: 'POST', body: JSON.stringify({ partNumbers: batch }) },
        ).then((signed) => {
          for (const part of signed.parts) signedUrls.set(part.partNumber, part.uploadUrl)
        }).finally(() => { signingPromise = null })
      }
      await signingPromise
      if (signedUrls.has(partNumber)) break
      if (initiated) break
      forceSingle = true
    }
    const url = signedUrls.get(partNumber)
    if (!url) throw new Error(`分片 ${partNumber} 已由其他会话完成，请刷新任务`)
    return url
  }

  async function uploadOne(partNumber: number) {
    const start = (partNumber - 1) * options.session.partSizeBytes
    const end = Math.min(options.file.size, start + options.session.partSizeBytes)
    const blob = options.file.slice(start, end)
    let attempt = 0
    while (attempt < 2) {
      attempt += 1
      const uploadUrl = await signFor(partNumber, attempt > 1)
      try {
        const etag = await putPart(uploadUrl, blob, options.signal, (loaded) => { inflight.set(partNumber, loaded); report() })
        const recorded = await options.api.fetchJson<{ partNumber: number; sizeBytes: number; etag: string }>(
          `/uploads/${options.session.id}/parts/${partNumber}`,
          { method: 'POST', body: JSON.stringify({ sizeBytes: blob.size, etag }) },
        )
        inflight.delete(partNumber)
        signedUrls.delete(partNumber)
        const part = { ...recorded, completedAt: new Date().toISOString() }
        completed.set(partNumber, part)
        report()
        await options.onPart(part)
        return
      } catch (error) {
        inflight.delete(partNumber)
        report()
        if (!(error instanceof UploadTransportError) || ![401, 403].includes(error.status) || attempt >= 2) throw error
      }
    }
  }

  async function worker() {
    while (!options.signal.aborted) {
      const index = cursor
      cursor += 1
      if (index >= missing.length) return
      await uploadOne(missing[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, missing.length) }, () => worker()))
  if (options.signal.aborted) throw new DOMException('上传已暂停', 'AbortError')
  options.onVerifying?.()
  return options.api.fetchJson<{ upload: UploadSessionView; mediaAssetId: string }>(
    `/uploads/${options.session.id}/complete`, { method: 'POST' },
  )
}
