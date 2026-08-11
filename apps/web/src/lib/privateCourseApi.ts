import type { PrivateCourseSummary, PrivateLessonDetail, ProcessingJob, TranslateCourseResponse, UploadCompletion, UploadRequest, UploadTarget } from '@online-learning/contracts'

const apiBase = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3001/api').replace(/\/$/, '')
const developerToken = 'dev-access.local-learner'

async function request<T>(path: string, init: RequestInit = {}, parse: (value: unknown) => T): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${developerToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch {
    throw new Error('无法连接本地 API（127.0.0.1:3001）。请先启动 PostgreSQL、Redis、MinIO、API 和 Worker。')
  }
  const text = await response.text()
  const body = text ? JSON.parse(text) as unknown : null
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'message' in body ? (body as { message?: unknown }).message : null
    throw new Error(typeof detail === 'string' ? detail : `请求失败（${response.status}）`)
  }
  return parse(body)
}

function asUploadTarget(value: unknown) {
  if (!value || typeof value !== 'object' || typeof (value as { putUrl?: unknown }).putUrl !== 'string') throw new Error('上传地址响应无效')
  return value as UploadTarget
}

function asCompletion(value: unknown) {
  if (!value || typeof value !== 'object' || !('job' in value)) throw new Error('上传完成响应无效')
  return value as UploadCompletion
}

function asJob(value: unknown) {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') throw new Error('任务响应无效')
  return value as ProcessingJob
}

function asTranslation(value: unknown) {
  if (!value || typeof value !== 'object' || !('coverage' in value) || !('queued' in value)) throw new Error('中文翻译任务响应无效')
  return value as TranslateCourseResponse
}

function asCourses(value: unknown) {
  if (!Array.isArray(value)) throw new Error('私有课程响应无效')
  return value as PrivateCourseSummary[]
}

function asCourse(value: unknown) {
  if (!value || typeof value !== 'object' || typeof (value as { playbackUrl?: unknown }).playbackUrl !== 'string') throw new Error('课程详情响应无效')
  return value as PrivateLessonDetail
}

export function createUploadTarget(input: UploadRequest) {
  return request('/uploads/presign', { method: 'POST', body: JSON.stringify(input) }, asUploadTarget)
}

export function putVideoFile(url: string, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('content-type', file.type || 'video/mp4')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onerror = () => reject(new Error('浏览器无法上传到 MinIO，请检查 MinIO CORS 与服务状态'))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`MinIO 上传失败（${xhr.status}）：${xhr.responseText || '未知错误'}`))
    }
    xhr.send(file)
  })
}

export function completeUpload(uploadId: string) {
  return request(`/uploads/${uploadId}/complete`, { method: 'POST', body: '{}' }, asCompletion)
}

export function getProcessingJob(jobId: string) {
  return request(`/me/jobs/${jobId}`, {}, asJob)
}

export function retryUpload(uploadId: string) {
  return request(`/uploads/${uploadId}/retry`, { method: 'POST', body: '{}' }, asJob)
}

export function listPrivateCourses() {
  return request('/me/courses', {}, asCourses)
}

export function getPrivateCourse(id: string) {
  return request(`/me/courses/${id}`, {}, asCourse)
}

export function translatePrivateCourse(id: string): Promise<TranslateCourseResponse> {
  return request(`/me/courses/${id}/translate`, { method: 'POST', body: '{}' }, asTranslation)
}

export type { PrivateCourseSummary, PrivateLessonDetail, ProcessingJob }
