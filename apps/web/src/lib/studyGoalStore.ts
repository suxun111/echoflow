export const STUDY_GOAL_STORAGE_KEY = 'echoflow_daily_study_goal'
export const DEFAULT_DAILY_GOAL_MINUTES = 30

const STUDY_GOAL_CHANGE_EVENT = 'echoflow:daily-study-goal-change'
const MAX_GOAL_MINUTES = 480
let cachedGoalKey: string | null = null
let cachedGoal: DailyStudyGoal | null = null

type DailyStudyRecord = {
  goalMinutes: number
  studiedSeconds: number
  completionCelebrated: boolean
}

type PersistedStudyGoalState = {
  preferredGoalMinutes: number
  days: Record<string, DailyStudyRecord>
}

export type DailyStudyGoal = {
  date: string
  targetMinutes: number
  targetSeconds: number
  studiedSeconds: number
  studiedMinutes: number
  progressPercent: number
  visualProgressPercent: number
  remainingSeconds: number
  isComplete: boolean
  isExceeded: boolean
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

function normalizeGoalMinutes(value: unknown) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return DEFAULT_DAILY_GOAL_MINUTES
  return Math.min(MAX_GOAL_MINUTES, Math.max(1, Math.round(minutes)))
}

function isDailyStudyRecord(value: unknown): value is DailyStudyRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<DailyStudyRecord>
  return Number.isFinite(record.goalMinutes)
    && Number.isFinite(record.studiedSeconds)
    && typeof record.completionCelebrated === 'boolean'
}

function getInitialState(): PersistedStudyGoalState {
  return { preferredGoalMinutes: DEFAULT_DAILY_GOAL_MINUTES, days: {} }
}

function readStudyGoalState(): PersistedStudyGoalState {
  if (!canUseStorage()) return getInitialState()

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STUDY_GOAL_STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return getInitialState()
    const state = parsed as Partial<PersistedStudyGoalState>
    const days = Object.entries(state.days ?? {}).reduce<Record<string, DailyStudyRecord>>((result, [date, record]) => {
      if (!isDailyStudyRecord(record)) return result
      result[date] = {
        goalMinutes: normalizeGoalMinutes(record.goalMinutes),
        studiedSeconds: Math.max(0, Math.round(record.studiedSeconds)),
        completionCelebrated: record.completionCelebrated,
      }
      return result
    }, {})

    return {
      preferredGoalMinutes: normalizeGoalMinutes(state.preferredGoalMinutes),
      days,
    }
  } catch {
    return getInitialState()
  }
}

function notifyStudyGoalChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(STUDY_GOAL_CHANGE_EVENT))
}

function writeStudyGoalState(state: PersistedStudyGoalState) {
  if (!canUseStorage()) return
  window.localStorage.setItem(STUDY_GOAL_STORAGE_KEY, JSON.stringify(state))
  notifyStudyGoalChange()
}

function toGoalSnapshot(state: PersistedStudyGoalState, date: Date): DailyStudyGoal {
  const dateKey = localDateKey(date)
  const record = state.days[dateKey]
  const targetMinutes = record?.goalMinutes ?? state.preferredGoalMinutes
  const targetSeconds = targetMinutes * 60
  const studiedSeconds = record?.studiedSeconds ?? 0
  const progressPercent = targetSeconds ? (studiedSeconds / targetSeconds) * 100 : 0

  return {
    date: dateKey,
    targetMinutes,
    targetSeconds,
    studiedSeconds,
    studiedMinutes: Math.floor(studiedSeconds / 60),
    progressPercent,
    visualProgressPercent: Math.min(progressPercent, 100),
    remainingSeconds: Math.max(0, targetSeconds - studiedSeconds),
    isComplete: progressPercent >= 100,
    isExceeded: progressPercent > 100,
  }
}

export function getDailyStudyGoal(date = new Date()) {
  const snapshot = toGoalSnapshot(readStudyGoalState(), date)
  const cacheKey = [
    snapshot.date,
    snapshot.targetMinutes,
    snapshot.studiedSeconds,
    snapshot.isComplete,
  ].join(':')
  if (cacheKey === cachedGoalKey && cachedGoal) return cachedGoal
  cachedGoalKey = cacheKey
  cachedGoal = snapshot
  return snapshot
}

export function setDailyGoalMinutes(minutes: number, date = new Date()) {
  const state = readStudyGoalState()
  const targetMinutes = normalizeGoalMinutes(minutes)
  const dateKey = localDateKey(date)
  const existing = state.days[dateKey]
  const next: PersistedStudyGoalState = {
    preferredGoalMinutes: targetMinutes,
    days: {
      ...state.days,
      [dateKey]: {
        goalMinutes: targetMinutes,
        studiedSeconds: existing?.studiedSeconds ?? 0,
        completionCelebrated: existing?.completionCelebrated ?? false,
      },
    },
  }

  writeStudyGoalState(next)
  return toGoalSnapshot(next, date)
}

export function addStudySeconds(seconds: number, date = new Date()) {
  const increment = Math.max(0, Math.round(seconds))
  if (!increment) return { goal: getDailyStudyGoal(date), completedNow: false }

  const state = readStudyGoalState()
  const dateKey = localDateKey(date)
  const existing = state.days[dateKey]
  const targetMinutes = existing?.goalMinutes ?? state.preferredGoalMinutes
  const targetSeconds = targetMinutes * 60
  const previousSeconds = existing?.studiedSeconds ?? 0
  const studiedSeconds = previousSeconds + increment
  const completedNow = previousSeconds < targetSeconds
    && studiedSeconds >= targetSeconds
    && !existing?.completionCelebrated
  const record: DailyStudyRecord = {
    goalMinutes: targetMinutes,
    studiedSeconds,
    completionCelebrated: Boolean(existing?.completionCelebrated || completedNow),
  }
  const next: PersistedStudyGoalState = {
    ...state,
    days: { ...state.days, [dateKey]: record },
  }

  writeStudyGoalState(next)
  return { goal: toGoalSnapshot(next, date), completedNow }
}

export function subscribeStudyGoal(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined

  const handleStorage = (event: StorageEvent) => {
    if (event.key === STUDY_GOAL_STORAGE_KEY) listener()
  }

  window.addEventListener(STUDY_GOAL_CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(STUDY_GOAL_CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}

export function getGoalAccent(progressPercent: number) {
  if (progressPercent > 100) return '#4e32bf'

  const progress = Math.min(100, Math.max(0, progressPercent)) / 100
  const saturation = Math.round(48 + progress * 30)
  const lightness = Math.round(77 - progress * 24)
  return 'hsl(255 ' + saturation + '% ' + lightness + '%)'
}

export function formatStudyDuration(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds))
  if (wholeSeconds > 0 && wholeSeconds < 60) return wholeSeconds + ' 秒'
  return Math.floor(wholeSeconds / 60) + ' 分钟'
}
