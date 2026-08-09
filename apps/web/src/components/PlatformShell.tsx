import { type CSSProperties, type ReactNode, useSyncExternalStore } from 'react'
import type { AppView } from '../types'
import { formatStudyDuration, getDailyStudyGoal, getGoalAccent, subscribeStudyGoal } from '../lib/studyGoalStore'
import { getVocabularyCount, subscribeVocabulary } from '../lib/vocabularyStore'
import { Icon } from './Icon'

const navigation: { id: AppView; label: string; icon: string }[] = [
  { id: 'home', label: '首页', icon: 'home' }, { id: 'discover', label: '发现课程', icon: 'compass' },
  { id: 'favorites', label: '我的收藏', icon: 'heart' }, { id: 'history', label: '学习记录', icon: 'clock' },
  { id: 'vocabulary', label: '生词本', icon: 'book' },
]

function Logo() { return <div className="brand"><span className="brand-mark"><i/><i/><i/></span><span>EchoFlow</span></div> }

function DailyGoalCard({ onOpen }: { onOpen: () => void }) {
  const goal = useSyncExternalStore(subscribeStudyGoal, getDailyStudyGoal, () => getDailyStudyGoal())
  const roundedProgress = Math.max(0, Math.round(goal.progressPercent))
  const ringStyle = {
    '--goal-progress': String(goal.visualProgressPercent),
    '--goal-color': getGoalAccent(goal.progressPercent),
  } as CSSProperties
  const summary = goal.isExceeded
    ? Math.floor((goal.studiedSeconds - goal.targetSeconds) / 60) > 0
      ? '超额完成 ' + Math.floor((goal.studiedSeconds - goal.targetSeconds) / 60) + ' 分钟'
      : '今日目标已完成'
    : goal.isComplete
      ? '今日目标已完成'
      : '已学习 ' + formatStudyDuration(goal.studiedSeconds) + ' / ' + goal.targetMinutes + ' 分钟'

  return <button type="button" className={'daily-goal' + (goal.isExceeded ? ' is-exceeded' : goal.isComplete ? ' is-complete' : '')} onClick={onOpen}>
    <div className="goal-ring" style={ringStyle} role="progressbar" aria-label="今日学习目标进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(goal.visualProgressPercent)} aria-valuetext={roundedProgress + '%，' + summary}>
      <span>{roundedProgress}%</span>
    </div>
    <div><strong>今日目标</strong><p>{summary}</p></div>
  </button>
}

export function PlatformShell({ children, view, search, onSearch, onView, onUpload }: { children: ReactNode; view: AppView; search: string; onSearch: (value: string) => void; onView: (view: AppView) => void; onUpload: () => void }) {
  const vocabularyCount = useSyncExternalStore(subscribeVocabulary, getVocabularyCount, () => 0)

  return <div className="platform-shell"><aside className="sidebar"><Logo/><nav className="side-nav" aria-label="主导航">{navigation.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => onView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.id === 'vocabulary' && vocabularyCount > 0 && <b>{vocabularyCount}</b>}</button>)}</nav><div className="side-divider"/><p className="side-label">我的空间</p><button className={`side-upload ${view === 'uploads' ? 'active' : ''}`} onClick={() => onView('uploads')}><Icon name="upload"/><span>个人上传</span><small>AI 字幕</small></button><DailyGoalCard onOpen={() => onView('history')}/><button className="profile-button" onClick={() => onView('settings')}><span className="avatar">L</span><span><strong>Lena</strong><small>连续学习 7 天</small></span><Icon name="settings" size={17}/></button></aside>
    <div className="content-shell"><header className="topbar"><div className="mobile-logo"><Logo/></div><label className="search-box"><Icon name="search" size={18}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索视频、主题或创作者"/><kbd>⌘ K</kbd></label><div className="top-actions"><button className="upload-action" onClick={onUpload}><Icon name="upload" size={17}/>上传视频</button><button className="notification" aria-label="通知"><span>3</span>♧</button><span className="top-avatar">L</span></div></header>{children}</div></div>
}
