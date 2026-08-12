import { type ReactNode } from 'react'
import type { AuthUser } from '@online-learning/contracts'
import type { AppView } from '../types'
import { Icon } from './Icon'

const navigation: { id: AppView; label: string; icon: string }[] = [
  { id: 'home', label: '我的视频', icon: 'home' },
  { id: 'uploads', label: '上传与处理', icon: 'upload' },
]

function Logo() { return <div className="brand"><span className="brand-mark"><i/><i/><i/></span><span>EchoFlow</span></div> }

export function PlatformShell({ children, view, search, user, onSearch, onView, onLogout }: { children: ReactNode; view: AppView; search: string; user: AuthUser; onSearch: (value: string) => void; onView: (view: AppView) => void; onLogout: () => void }) {
  return <div className="platform-shell"><aside className="sidebar"><Logo/><nav className="side-nav" aria-label="主导航">{navigation.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => onView(item.id)}><Icon name={item.icon}/><span>{item.label}</span></button>)}</nav><div className="side-divider"/><p className="side-label">私人空间</p><p className="private-note">原片、字幕和进度默认只属于你。</p><button className="profile-button" onClick={onLogout} title="退出登录"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>退出登录</small></span><Icon name="settings" size={17}/></button></aside>
    <div className="content-shell"><header className="topbar"><div className="mobile-logo"><Logo/></div><label className="search-box"><Icon name="search" size={18}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索我的视频"/><kbd>⌘ K</kbd></label><div className="top-actions"><button className="upload-action" onClick={() => onView('uploads')}><Icon name="upload" size={17}/>上传视频</button><span className="top-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span></div></header>{children}</div></div>
}
