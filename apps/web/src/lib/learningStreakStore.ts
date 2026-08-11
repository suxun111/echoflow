export const LEARNING_STREAK_STORAGE_KEY = 'echoflow_learning_streak'

const LEARNING_STREAK_CHANGE_EVENT = 'echoflow:learning-streak-change'
let cachedStreakKey: string | null = null
let cachedStreak: LearningStreak | null = null

type PersistedLearningStreak = {
  days: number
  lastActiveDate: string
}

export type LearningStreak = {
  days: number
  lastActiveDate: string | null
  isAtRisk: boolean
}

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

export function millisecondsUntilNextLocalDay(date = new Date()) {
  const nextDay = new Date(date)
  nextDay.setHours(24, 0, 0, 0)
  return nextDay.getTime() - date.getTime()
}

function dateDistance(from: string, to: string) {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number)
  const [toYear, toMonth, toDay] = to.split('-').map(Number)
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000)
}

function isPersistedLearningStreak(value: unknown): value is PersistedLearningStreak {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<PersistedLearningStreak>
  return Number.isFinite(record.days)
    && Number(record.days) > 0
    && typeof record.lastActiveDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(record.lastActiveDate)
}

function readLearningStreak(): PersistedLearningStreak | null {
  if (!canUseStorage()) return null

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LEARNING_STREAK_STORAGE_KEY) ?? 'null')
    if (!isPersistedLearningStreak(parsed)) return null
    return {
      days: Math.max(1, Math.round(parsed.days)),
      lastActiveDate: parsed.lastActiveDate,
    }
  } catch {
    return null
  }
}

function notifyLearningStreakChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LEARNING_STREAK_CHANGE_EVENT))
}

function writeLearningStreak(record: PersistedLearningStreak) {
  if (!canUseStorage()) return
  window.localStorage.setItem(LEARNING_STREAK_STORAGE_KEY, JSON.stringify(record))
  notifyLearningStreakChange()
}

function toSnapshot(record: PersistedLearningStreak | null, date: Date): LearningStreak {
  if (!record) return { days: 0, lastActiveDate: null, isAtRisk: false }

  const distance = dateDistance(record.lastActiveDate, localDateKey(date))
  if (distance > 1) return { days: 0, lastActiveDate: null, isAtRisk: false }

  return {
    days: record.days,
    lastActiveDate: record.lastActiveDate,
    isAtRisk: distance === 1,
  }
}

export function getLearningStreak(date = new Date()) {
  const snapshot = toSnapshot(readLearningStreak(), date)
  const cacheKey = [snapshot.days, snapshot.lastActiveDate, snapshot.isAtRisk].join(':')
  if (cacheKey === cachedStreakKey && cachedStreak) return cachedStreak
  cachedStreakKey = cacheKey
  cachedStreak = snapshot
  return snapshot
}

export function recordLearningActivity(date = new Date()) {
  const today = localDateKey(date)
  const current = readLearningStreak()

  if (current?.lastActiveDate === today) return toSnapshot(current, date)

  const next: PersistedLearningStreak = {
    days: current && dateDistance(current.lastActiveDate, today) === 1 ? current.days + 1 : 1,
    lastActiveDate: today,
  }
  writeLearningStreak(next)
  return toSnapshot(next, date)
}

export function refreshLearningStreak() {
  notifyLearningStreakChange()
}

export function subscribeLearningStreak(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined

  const handleStorage = (event: StorageEvent) => {
    if (event.key === LEARNING_STREAK_STORAGE_KEY) listener()
  }

  window.addEventListener(LEARNING_STREAK_CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(LEARNING_STREAK_CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}
