import type { ReactNode } from 'react'
import type { AppView } from '../types'
import { Icon } from './Icon'

const navigation: { id: AppView; label: string; icon: string }[] = [
  { id: 'home', label: '首页', icon: 'home' }, { id: 'discover', label: '发现课程', icon: 'compass' },
  { id: 'favorites', label: '我的收藏', icon: 'heart' }, { id: 'history', label: '学习记录', icon: 'clock' },
  { id: 'vocabulary', label: '生词本', icon: 'book' },
]

function Logo() { return <div className="brand"><span className="brand-mark"><i/><i/><i/></span><span>EchoFlow</span></div> }

export function PlatformShell({ children, view, search, onSearch, onView, onUpload }: { children: ReactNode; view: AppView; search: string; onSearch: (value: string) => void; onView: (view: AppView) => void; onUpload: () => void }) {
  return <div className="platform-shell"><aside className="sidebar"><Logo/><nav className="side-nav" aria-label="主导航">{navigation.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => onView(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.id === 'vocabulary' && <b>12</b>}</button>)}</nav><div className="side-divider"/><p className="side-label">我的空间</p><button className={`side-upload ${view === 'uploads' ? 'active' : ''}`} onClick={() => onView('uploads')}><Icon name="upload"/><span>个人上传</span><small>AI 字幕</small></button><div className="daily-goal"><div className="goal-ring"><span>68</span></div><div><strong>今日目标</strong><p>已学习 21 分钟</p></div></div><button className="profile-button" onClick={() => onView('settings')}><span className="avatar">L</span><span><strong>Lena</strong><small>连续学习 7 天</small></span><Icon name="settings" size={17}/></button></aside>
    <div className="content-shell"><header className="topbar"><div className="mobile-logo"><Logo/></div><label className="search-box"><Icon name="search" size={18}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索视频、主题或创作者"/><kbd>⌘ K</kbd></label><div className="top-actions"><button className="upload-action" onClick={onUpload}><Icon name="upload" size={17}/>上传视频</button><button className="notification" aria-label="通知"><span>3</span>♧</button><span className="top-avatar">L</span></div></header>{children}</div></div>
}
