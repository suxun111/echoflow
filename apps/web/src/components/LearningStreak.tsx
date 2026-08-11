import { useState, useSyncExternalStore } from 'react'
import { getLearningStreak, subscribeLearningStreak, type LearningStreak } from '../lib/learningStreakStore'

type FlameTone = 'cold' | 'ember' | 'glow' | 'bright' | 'blaze'

type FlameVisual = {
  tone: FlameTone
  headline: string
  label: string
}

function getFlameVisual(days: number): FlameVisual {
  if (days <= 0) return { tone: 'cold', headline: '火花熄灭', label: '今天练一句，重新点亮' }
  if (days === 1) return { tone: 'ember', headline: '1 天', label: '火花刚刚点亮' }
  if (days <= 3) return { tone: 'glow', headline: days + ' 天', label: '小火慢燃中' }
  if (days <= 6) return { tone: 'bright', headline: days + ' 天', label: '火焰越来越旺' }
  return { tone: 'blaze', headline: days + ' 天', label: days >= 14 ? '烈焰连燃，保持住' : '连续学习，火焰正旺' }
}

function messageFor(streak: LearningStreak, visual: FlameVisual, isPreviewing: boolean) {
  if (isPreviewing) return '预览：' + visual.label
  if (streak.isAtRisk) return '今天还没学习，别让火花熄灭'
  return visual.label
}

function Flame({ tone }: { tone: FlameTone }) {
  return <span className={'learning-flame learning-flame--' + tone} aria-hidden="true">
    <b className="learning-flame__emoji">🔥</b>
    <i className="learning-flame__outer"/>
    <i className="learning-flame__middle"/>
    <i className="learning-flame__core"/>
    <i className="learning-flame__spark learning-flame__spark--one"/>
    <i className="learning-flame__spark learning-flame__spark--two"/>
  </span>
}

export function LearningStreak() {
  const streak = useSyncExternalStore(subscribeLearningStreak, getLearningStreak, () => getLearningStreak())
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [previewDays, setPreviewDays] = useState<number | null>(null)
  const canPreview = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  const isPreviewing = previewDays !== null
  const displayedDays = previewDays ?? streak.days
  const visual = getFlameVisual(displayedDays)
  const description = messageFor(streak, visual, isPreviewing)

  return <section className={'learning-streak learning-streak--' + visual.tone} aria-label={visual.headline + '，' + description}>
    <Flame tone={visual.tone}/>
    <div className="learning-streak__copy"><strong>{visual.headline}</strong><small>{isPreviewing ? description : streak.days > 0 ? '连续学习' : description}</small></div>
    {canPreview && <button className="learning-streak__preview-trigger" type="button" onClick={() => setIsPreviewOpen((open) => !open)} aria-expanded={isPreviewOpen} aria-label="预览连续学习火焰变化">预览</button>}
    {canPreview && isPreviewOpen && <div className="learning-streak__preview-panel">
      <p>火焰效果预览</p>
      <span>{description}</span>
      <div>
        <button type="button" onClick={() => setPreviewDays(1)}>重新点亮</button>
        <button type="button" onClick={() => setPreviewDays((days) => Math.min((days ?? streak.days) + 1, 365))}>连续 +1 天</button>
        <button type="button" onClick={() => setPreviewDays(0)}>模拟中断</button>
      </div>
      <button className="learning-streak__preview-reset" type="button" onClick={() => { setPreviewDays(null); setIsPreviewOpen(false) }}>恢复真实记录</button>
      <small>预览不会修改你的学习记录。</small>
    </div>}
  </section>
}

export function LearningStreakLabel() {
  const streak = useSyncExternalStore(subscribeLearningStreak, getLearningStreak, () => getLearningStreak())
  return <small>{streak.days > 0 ? '连续学习 ' + streak.days + ' 天' : '今天练一句，点亮火花'}</small>
}
