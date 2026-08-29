import { type ReactNode } from 'react'
import type { AuthUser } from '@online-learning/contracts'
import type { AppView } from '../types'
import { Icon } from './Icon'

const navigation: { id: AppView; label: string; icon: string }[] = [
  { id: 'home', label: '我的视频', icon: 'home' },
  { id: 'uploads', label: '上传与处理', icon: 'upload' },
]

function Logo() { return <div className="brand"><span className="brand-mark"><i/><i/><i/></span><span>EchoFlow</span></div> }

export function PlatformShell({ children, view, search, user, onSearch, onView, onLogout, showIntegrationPreview = false }: { children: ReactNode; view: AppView; search: string; user: AuthUser; onSearch: (value: string) => void; onView: (view: AppView) => void; onLogout: () => void; showIntegrationPreview?: boolean }) {
  return <div className="platform-shell"><aside className="sidebar"><Logo/><nav className="side-nav" aria-label="主导航">{navigation.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}><Icon name={item.icon}/><span>{item.label}</span></button>)}</nav>{showIntegrationPreview && <><div className="side-divider developer-divider"/><p className="side-label">开发验证</p><button className={`side-dev-preview${view === 'integration-preview' ? ' active' : ''}`} aria-current={view === 'integration-preview' ? 'page' : undefined} onClick={() => onView('integration-preview')}><Icon name="note"/><span>V1 学习验证</span></button></>}<div className="side-divider"/><p className="side-label">私人空间</p><p className="private-note">原片、字幕和进度默认只属于你。</p><button className="profile-button" onClick={onLogout} title="退出登录"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>退出登录</small></span><Icon name="logout" size={17}/></button></aside>
    <div className="content-shell"><header className="topbar"><div className="mobile-logo"><Logo/></div><label className="search-box"><Icon name="search" size={18}/><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索我的视频" aria-label="搜索我的视频"/></label><div className="top-actions"><button className="upload-action" onClick={() => onView('uploads')}><Icon name="upload" size={17}/>上传视频</button><span className="top-avatar" aria-label={`${user.displayName} 的账号`}>{user.displayName.slice(0, 1).toUpperCase()}</span></div></header>{children}</div>
    <nav className="mobile-nav" aria-label="移动端主导航">{navigation.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}><Icon name={item.icon} size={18}/><span>{item.label}</span></button>)}{showIntegrationPreview && <button className={view === 'integration-preview' ? 'active' : ''} aria-current={view === 'integration-preview' ? 'page' : undefined} onClick={() => onView('integration-preview')}><Icon name="note" size={18}/><span>学习验证</span></button>}</nav></div>
}
