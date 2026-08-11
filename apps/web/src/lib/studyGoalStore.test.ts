import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DAILY_GOAL_MINUTES,
  STUDY_GOAL_STORAGE_KEY,
  addStudySeconds,
  getDailyStudyGoal,
  setDailyGoalMinutes,
} from './studyGoalStore'

const today = new Date(2026, 7, 9, 12, 0, 0)

afterEach(() => {
  window.localStorage.clear()
})

describe('study goal store', () => {
  it('uses a 30-minute goal until the learner customizes it', () => {
    expect(getDailyStudyGoal(today)).toMatchObject({
      targetMinutes: DEFAULT_DAILY_GOAL_MINUTES,
      studiedSeconds: 0,
      progressPercent: 0,
    })

    const goal = setDailyGoalMinutes(45, today)

    expect(goal).toMatchObject({ targetMinutes: 45, studiedSeconds: 0 })
    expect(window.localStorage.getItem(STUDY_GOAL_STORAGE_KEY)).toContain('45')
  })

  it('announces completion only when active learning first crosses the goal', () => {
    setDailyGoalMinutes(20, today)

    expect(addStudySeconds(19 * 60, today)).toMatchObject({ completedNow: false })
    expect(addStudySeconds(60, today)).toMatchObject({ completedNow: true })
    expect(addStudySeconds(30, today)).toMatchObject({ completedNow: false })
    expect(getDailyStudyGoal(today)).toMatchObject({
      targetMinutes: 20,
      studiedMinutes: 20,
      isComplete: true,
      isExceeded: true,
      visualProgressPercent: 100,
    })
  })

  it('updates progress without celebrating when only the target is lowered', () => {
    setDailyGoalMinutes(30, today)
    addStudySeconds(20 * 60, today)

    const goal = setDailyGoalMinutes(15, today)

    expect(goal).toMatchObject({ isComplete: true, isExceeded: true })
    expect(addStudySeconds(1, today).completedNow).toBe(false)
  })
})
