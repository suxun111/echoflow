import { useEffect } from 'react'
import type { DailyStudyGoal } from '../lib/studyGoalStore'
import { Icon } from './Icon'

const encouragements = [
  '今天的目标完成了，保持这个节奏。',
  '很棒，专注的每一分钟都在让表达更自然。',
  '目标达成。再练一句，或者带着成就感休息一下。',
]

function messageFor(date: string) {
  const index = date.split('').reduce((total, character) => total + character.charCodeAt(0), 0) % encouragements.length
  return encouragements[index]
}

export function GoalCompletionModal({ goal, onClose }: { goal: DailyStudyGoal; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="goal-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="goal-completion-modal" role="dialog" aria-modal="true" aria-labelledby="goal-completion-title">
      <button className="goal-modal-close" type="button" onClick={onClose} aria-label="关闭鼓励提示"><Icon name="close" size={17}/></button>
      <span className="goal-completion-icon"><Icon name="sparkles" size={26}/></span>
      <p>DAILY GOAL COMPLETE</p>
      <h2 id="goal-completion-title">今天的学习目标完成了</h2>
      <span>已学习 {goal.studiedMinutes} / {goal.targetMinutes} 分钟</span>
      <strong>{messageFor(goal.date)}</strong>
      <button className="goal-modal-action" type="button" onClick={onClose}>继续学习</button>
    </section>
  </div>
}
