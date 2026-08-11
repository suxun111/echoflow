import { type CSSProperties, useEffect, useState, useSyncExternalStore } from 'react'
import type { AppView } from '../../types'
import { Icon } from '../../components/Icon'
import {
  formatStudyDuration,
  getDailyStudyGoal,
  getGoalAccent,
  setDailyGoalMinutes,
  subscribeStudyGoal,
} from '../../lib/studyGoalStore'
import {
  getVocabulary,
  getVocabularyCount,
  removeVocabularyWord,
  subscribeVocabulary,
} from '../../lib/vocabularyStore'

export function AccountPage({ view }: { view: AppView }) {
  if (view === 'vocabulary') return <VocabularyBook />
  if (view === 'settings') return <GoalSettings />
  if (view === 'history') return <StudyHistory />

  return <main className="simple-page"><div className="simple-heading"><div><p>YOUR ECHOFLOW</p><h1>发现课程</h1><span>更多精选内容正在整理中。</span></div></div><div className="simple-placeholder"><span className="modal-icon"><Icon name="clock" size={28}/></span><h2>功能界面已纳入下一阶段</h2><p>当前原型优先展示资源库、学习页和个人上传的核心体验。</p></div></main>
}

function StudyHistory() {
  const goal = useSyncExternalStore(subscribeStudyGoal, getDailyStudyGoal, () => getDailyStudyGoal())
  const progress = Math.round(goal.progressPercent)
  const summary = goal.isExceeded
    ? '今天已超额完成学习目标。'
    : goal.isComplete
      ? '今天的学习目标已经完成。'
      : '还差 ' + Math.ceil(goal.remainingSeconds / 60) + ' 分钟完成今天的计划。'

  return <main className="simple-page">
    <div className="simple-heading"><div><p>YOUR ECHOFLOW</p><h1>学习记录</h1><span>先从今天的学习节奏开始，持续积累属于你的记录。</span></div></div>
    <section className="study-history-card">
      <div className="study-history-icon"><Icon name="clock" size={26}/></div>
      <div><span>今日学习</span><h2>{progress}%</h2><p>{summary}</p></div>
      <strong>{formatStudyDuration(goal.studiedSeconds)} / {goal.targetMinutes} 分钟</strong>
    </section>
  </main>
}

function GoalSettings() {
  const goal = useSyncExternalStore(subscribeStudyGoal, getDailyStudyGoal, () => getDailyStudyGoal())
  const [goalInput, setGoalInput] = useState(String(goal.targetMinutes))
  const progress = Math.round(goal.progressPercent)
  const ringStyle = {
    '--goal-progress': String(goal.visualProgressPercent),
    '--goal-color': getGoalAccent(goal.progressPercent),
  } as CSSProperties

  useEffect(() => setGoalInput(String(goal.targetMinutes)), [goal.targetMinutes])

  const saveGoal = () => {
    const parsed = Number(goalInput)
    if (!Number.isFinite(parsed) || parsed < 1) {
      setGoalInput(String(goal.targetMinutes))
      return
    }
    setDailyGoalMinutes(parsed)
  }

  return <main className="simple-page">
    <div className="simple-heading"><div><p>YOUR ECHOFLOW</p><h1>每日学习目标</h1><span>设定适合自己的节奏，今天的进度会随有效学习时长自动更新。</span></div></div>
    <section className="goal-settings-card">
      <div className="goal-settings-summary">
        <div className="goal-settings-ring" style={ringStyle}><span>{progress}%</span></div>
        <div><span>今日进度</span><strong>{formatStudyDuration(goal.studiedSeconds)} / {goal.targetMinutes} 分钟</strong><p>{goal.isExceeded ? '你已经超额完成今天的学习计划。' : goal.isComplete ? '今天的学习目标已经完成。' : '还差 ' + Math.ceil(goal.remainingSeconds / 60) + ' 分钟完成今日目标。'}</p></div>
      </div>
      <form className="goal-settings-form" onSubmit={(event) => { event.preventDefault(); saveGoal() }}>
        <label>快速选择</label>
        <div className="goal-preset-list">{[15, 30, 45, 60].map((minutes) => <button type="button" className={goal.targetMinutes === minutes ? 'active' : ''} key={minutes} onClick={() => setDailyGoalMinutes(minutes)}>{minutes} 分钟</button>)}</div>
        <label className="goal-custom-input">自定义分钟数<input type="number" min="1" max="480" step="1" value={goalInput} onChange={(event) => setGoalInput(event.target.value)} aria-label="自定义每日学习分钟数"/></label>
        <button className="goal-save-button" type="submit">保存今日目标</button>
        <small>支持 1–480 分钟。修改目标会立即更新今日进度，不会触发完成弹窗。</small>
      </form>
    </section>
  </main>
}

function VocabularyBook() {
  const vocabularyCount = useSyncExternalStore(subscribeVocabulary, getVocabularyCount, () => 0)
  const vocabulary = getVocabulary()

  return <main className="simple-page vocabulary-page">
    <div className="simple-heading">
      <div><p>YOUR ECHOFLOW</p><h1>生词本</h1><span>{vocabularyCount ? '已收录 ' + vocabularyCount + ' 个词条。' : '从字幕中收录想反复记住的单词或短语。'}</span></div>
    </div>
    {vocabulary.length ? <section className="vocabulary-book" aria-label="已保存的生词">
      <div className="vocabulary-book-heading"><span>单词</span><span>释义与语境</span><span>来源</span></div>
      <ul>
        {vocabulary.map((entry) => <li key={entry.normalizedWord}>
          <div className="vocabulary-word"><strong>{entry.word}</strong><small>{entry.level} · {entry.timestamp}</small></div>
          <div className="vocabulary-definition">
            <strong>{entry.meaning}</strong>
            <p>{entry.contextEnglish}</p>
            <small>{entry.contextChinese}</small>
          </div>
          <div className="vocabulary-source"><span>{entry.lessonTitle}</span><button type="button" onClick={() => removeVocabularyWord(entry.normalizedWord)} aria-label={'删除 ' + entry.word}><Icon name="close" size={15}/></button></div>
        </li>)}
      </ul>
    </section> : <div className="vocabulary-empty">
      <span className="modal-icon"><Icon name="book" size={28}/></span>
      <h2>生词本还是空的</h2>
      <p>在课程字幕里收录单词后，它们会出现在这里。</p>
    </div>}
  </main>
}
