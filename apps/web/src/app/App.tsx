import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { AuthUser } from '@online-learning/contracts'
import type { AppView } from '../types'
import { PlatformShell } from '../components/PlatformShell'
import { MyVideosPage } from '../features/library/MyVideosPage'
import { UploadsPage } from '../features/uploads/UploadsPage'
import { LoginPage } from '../features/auth/LoginPage'
import { ApiClient } from '../lib/apiClient'

export default function App() {
  const [view, setView] = useState<AppView>('home')
  const [search, setSearch] = useState('')
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [restoring, setRestoring] = useState(true)
  const deferredSearch = useDeferredValue(search)
  const api = useMemo(() => new ApiClient((token, nextUser) => {
    setAccessToken(token)
    if (nextUser) setUser(nextUser)
    else if (!token) setUser(null)
  }), [])

  useEffect(() => { void api.restore().finally(() => setRestoring(false)) }, [api])

  const openView = useCallback((next: AppView) => { setView(next); window.scrollTo(0, 0) }, [])

  if (restoring) return <div className="route-loading" role="status">正在恢复私人会话…</div>
  if (!accessToken || !user) return <LoginPage api={api}/>

  return <PlatformShell view={view} search={search} user={user} onSearch={setSearch} onView={openView} onLogout={() => void api.logout()}>
    {view === 'uploads'
      ? <UploadsPage api={api} />
      : <MyVideosPage api={api} search={deferredSearch} onUpload={() => openView('uploads')} />}
  </PlatformShell>
}
