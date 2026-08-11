import { afterEach, describe, expect, it } from 'vitest'
import {
  LEARNING_STREAK_STORAGE_KEY,
  getLearningStreak,
  millisecondsUntilNextLocalDay,
  recordLearningActivity,
} from './learningStreakStore'

const august7 = new Date(2026, 7, 7, 12, 0, 0)
const august8 = new Date(2026, 7, 8, 12, 0, 0)
const august9 = new Date(2026, 7, 9, 12, 0, 0)
const august10 = new Date(2026, 7, 10, 12, 0, 0)

afterEach(() => {
  window.localStorage.clear()
})

describe('learning streak store', () => {
  it('only records one active-learning day per calendar day', () => {
    expect(recordLearningActivity(august7)).toMatchObject({ days: 1, isAtRisk: false })
    expect(recordLearningActivity(august7)).toMatchObject({ days: 1, isAtRisk: false })
    expect(window.localStorage.getItem(LEARNING_STREAK_STORAGE_KEY)).toContain('2026-08-07')
  })

  it('grows after consecutive days and warns before a day is missed', () => {
    recordLearningActivity(august7)
    expect(recordLearningActivity(august8)).toMatchObject({ days: 2, isAtRisk: false })
    expect(getLearningStreak(august9)).toMatchObject({ days: 2, isAtRisk: true })
  })

  it('extinguishes after a full missed day and starts a new streak on return', () => {
    recordLearningActivity(august7)
    recordLearningActivity(august8)

    expect(getLearningStreak(august10)).toMatchObject({ days: 0, lastActiveDate: null })
    expect(recordLearningActivity(august10)).toMatchObject({ days: 1, isAtRisk: false })
  })

  it('calculates the next local midnight precisely', () => {
    expect(millisecondsUntilNextLocalDay(new Date(2026, 7, 7, 23, 59, 59, 500))).toBe(500)
    expect(millisecondsUntilNextLocalDay(new Date(2026, 7, 8, 0, 0, 0, 0))).toBe(86_400_000)
  })
})
