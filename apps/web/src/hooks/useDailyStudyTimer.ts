import { useEffect, useRef } from 'react'
import { addStudySeconds, type DailyStudyGoal } from '../lib/studyGoalStore'

function isDocumentActive() {
  return document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus())
}

export function useDailyStudyTimer(isLearning: boolean, onGoalReached?: (goal: DailyStudyGoal) => void) {
  const onGoalReachedRef = useRef(onGoalReached)

  useEffect(() => {
    onGoalReachedRef.current = onGoalReached
  }, [onGoalReached])

  useEffect(() => {
    if (!isLearning || typeof document === 'undefined') return

    let lastActiveAt: number | null = isDocumentActive() ? Date.now() : null

    const settleElapsedTime = () => {
      if (lastActiveAt === null) return
      const elapsedSeconds = Math.min(30, (Date.now() - lastActiveAt) / 1000)
      lastActiveAt = Date.now()
      const result = addStudySeconds(elapsedSeconds)
      if (result.completedNow) onGoalReachedRef.current?.(result.goal)
    }

    const pauseCounting = () => {
      settleElapsedTime()
      lastActiveAt = null
    }

    const resumeCounting = () => {
      if (isDocumentActive()) lastActiveAt = Date.now()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') resumeCounting()
      else pauseCounting()
    }

    const handleInterval = () => {
      if (isDocumentActive()) {
        if (lastActiveAt === null) resumeCounting()
        else settleElapsedTime()
      } else {
        lastActiveAt = null
      }
    }

    const interval = window.setInterval(handleInterval, 1000)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', pauseCounting)
    window.addEventListener('focus', resumeCounting)
    window.addEventListener('pagehide', pauseCounting)

    return () => {
      if (isDocumentActive()) settleElapsedTime()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', pauseCounting)
      window.removeEventListener('focus', resumeCounting)
      window.removeEventListener('pagehide', pauseCounting)
    }
  }, [isLearning])
}
