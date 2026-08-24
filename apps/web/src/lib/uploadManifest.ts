import type { UploadPartView, UploadSessionView } from '@online-learning/contracts'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_DURATION_MS } from './mediaLimits'

const DB_NAME = 'echoflow-private-uploads'
const STORE = 'manifests'

export type UploadManifest = {
  fileFingerprint: string
  uploadId: string
  fileName: string
  sizeBytes: number
  lastModified: number
  expiresAt: string
  parts: UploadPartView[]
  updatedAt: string
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地续传清单'))
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'fileFingerprint' })
    request.onsuccess = () => resolve(request.result)
  })
}

export async function saveUploadManifest(manifest: UploadManifest) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, 'readwrite').objectStore(STORE).put(manifest)
    request.onsuccess = () => { database.close(); resolve() }
    request.onerror = () => { database.close(); reject(request.error) }
  })
}

export async function getUploadManifest(fileFingerprint: string) {
  const database = await openDatabase()
  return new Promise<UploadManifest | undefined>((resolve, reject) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(fileFingerprint)
    request.onsuccess = () => { const result = request.result as UploadManifest | undefined; database.close(); resolve(result) }
    request.onerror = () => { database.close(); reject(request.error) }
  })
}

export async function removeUploadManifest(fileFingerprint: string) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, 'readwrite').objectStore(STORE).delete(fileFingerprint)
    request.onsuccess = () => { database.close(); resolve() }
    request.onerror = () => { database.close(); reject(request.error) }
  })
}

export function manifestFromSession(file: File, session: UploadSessionView): UploadManifest {
  return {
    fileFingerprint: session.fileFingerprint!,
    uploadId: session.id,
    fileName: file.name,
    sizeBytes: file.size,
    lastModified: file.lastModified,
    expiresAt: session.expiresAt,
    parts: session.parts,
    updatedAt: new Date().toISOString(),
  }
}

export async function fingerprintFile(file: File) {
  const sampleSize = 1024 * 1024
  const head = new Uint8Array(await file.slice(0, Math.min(sampleSize, file.size)).arrayBuffer())
  const tailStart = Math.max(0, file.size - sampleSize)
  const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
  const identity = new TextEncoder().encode(`${file.name}\n${file.size}\n${file.lastModified}\n`)
  const input = new Uint8Array(identity.length + head.length + tail.length)
  input.set(identity)
  input.set(head, identity.length)
  input.set(tail, identity.length + head.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')
}

export type LocalVideoInfo = { durationMs: number; width: number; height: number }

export async function inspectUploadFile(file: File): Promise<LocalVideoInfo> {
  if (!file.name.toLowerCase().endsWith('.mp4') || file.type !== 'video/mp4') throw new Error('请选择 MP4 视频文件')
  if (file.size <= 0) throw new Error('文件为空，无法上传')
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('单个视频不能超过 8 GiB')
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const release = () => { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const durationSeconds = video.duration
      const durationMs = Math.round(durationSeconds * 1000)
      const result = { durationMs, width: video.videoWidth, height: video.videoHeight }
      release()
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) reject(new Error('无法读取视频时长'))
      else if (durationSeconds > MAX_UPLOAD_DURATION_MS / 1000) reject(new Error('视频时长不能超过 60 分钟'))
      else resolve(result)
    }
    video.onerror = () => { release(); reject(new Error('浏览器无法读取该 MP4，请确认文件未损坏')) }
    video.src = url
  })
}
