import type { Recording } from '../types'

const DB_NAME = 'online-learning-recordings'
const STORE = 'recordings'

function getDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地录音库。'))
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('courseId', 'courseId', { unique: false })
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function recordingId(courseId: string, cueId: string) { return `${courseId}:${cueId}` }

export async function getRecording(courseId: string, cueId: string): Promise<Recording | undefined> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(recordingId(courseId, cueId))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result as Recording | undefined)
  })
}

export async function saveRecording(recording: Recording): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(recording)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

export async function deleteRecording(courseId: string, cueId: string): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(recordingId(courseId, cueId))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

export async function deleteCourseRecordings(courseId: string): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const index = transaction.objectStore(STORE).index('courseId')
    const request = index.openCursor(IDBKeyRange.only(courseId))
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) { cursor.delete(); cursor.continue() }
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
