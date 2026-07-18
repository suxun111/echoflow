import type { Course, PracticeProgress } from '../types'

const COURSES_KEY = 'online-learning:courses:v1'
const PROGRESS_KEY = 'online-learning:progress:v1'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function getCourses(): Course[] {
  return readJson<Course[]>(COURSES_KEY, []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveCourse(course: Course): void {
  const courses = getCourses()
  const index = courses.findIndex((item) => item.id === course.id)
  if (index >= 0) courses[index] = course
  else courses.push(course)
  localStorage.setItem(COURSES_KEY, JSON.stringify(courses))
}

export function deleteCourse(courseId: string): void {
  localStorage.setItem(COURSES_KEY, JSON.stringify(getCourses().filter((course) => course.id !== courseId)))
  const all = readJson<Record<string, PracticeProgress>>(PROGRESS_KEY, {})
  delete all[courseId]
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(all))
}

export function getProgress(courseId: string): PracticeProgress {
  const all = readJson<Record<string, PracticeProgress>>(PROGRESS_KEY, {})
  return all[courseId] ?? { courseId, currentCueIndex: 0, completedCueIds: [], loopEnabled: false, updatedAt: new Date().toISOString() }
}

export function saveProgress(progress: PracticeProgress): void {
  const all = readJson<Record<string, PracticeProgress>>(PROGRESS_KEY, {})
  all[progress.courseId] = { ...progress, updatedAt: new Date().toISOString() }
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(all))
}
