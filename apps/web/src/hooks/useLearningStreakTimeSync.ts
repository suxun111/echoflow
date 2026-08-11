import { useEffect } from 'react'
import { millisecondsUntilNextLocalDay, refreshLearningStreak } from '../lib/learningStreakStore'

export function useLearningStreakTimeSync() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    let nextMidnightTimer: number | null = null

    const scheduleNextMidnight = () => {
      if (nextMidnightTimer !== null) window.clearTimeout(nextMidnightTimer)
      nextMidnightTimer = window.setTimeout(() => {
        refreshLearningStreak()
        scheduleNextMidnight()
      }, millisecondsUntilNextLocalDay())
    }

    const synchronizeTime = () => {
      refreshLearningStreak()
      scheduleNextMidnight()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') synchronizeTime()
    }

    scheduleNextMidnight()
    window.addEventListener('focus', synchronizeTime)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      if (nextMidnightTimer !== null) window.clearTimeout(nextMidnightTimer)
      window.removeEventListener('focus', synchronizeTime)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
}
