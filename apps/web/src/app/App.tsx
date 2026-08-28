import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { AuthUser } from '@online-learning/contracts'
import type { AppView } from '../types'
import { PlatformShell } from '../components/PlatformShell'
import { MyVideosPage } from '../features/library/MyVideosPage'
import { UploadsPage } from '../features/uploads/UploadsPage'
import { LoginPage } from '../features/auth/LoginPage'
import { ApiClient } from '../lib/apiClient'

const previewHash = '#/integration-preview'
const integrationPreviewEnabled = import.meta.env.DEV
const IntegrationPreviewPage = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('../features/integration/IntegrationPreviewPage')).IntegrationPreviewPage }))
  : null

export default function App() {
  const [view, setView] = useState<AppView>(() => integrationPreviewEnabled && window.location.hash === previewHash ? 'integration-preview' : 'home')
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

  useEffect(() => {
    if (!integrationPreviewEnabled) return undefined
    const syncHash = () => setView(window.location.hash === previewHash ? 'integration-preview' : 'home')
    window.addEventListener('hashchange', syncHash)
    return () => window.removeEventListener('hashchange', syncHash)
  }, [])

  const openView = useCallback((next: AppView) => {
    if (!integrationPreviewEnabled && next === 'integration-preview') return
    if (integrationPreviewEnabled) {
      if (next === 'integration-preview' && window.location.hash !== previewHash) window.location.hash = '/integration-preview'
      if (next !== 'integration-preview' && window.location.hash === previewHash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
    setView(next)
    window.scrollTo(0, 0)
  }, [])

  if (restoring) return <div className="route-loading" role="status">正在恢复私人会话…</div>
  if (!accessToken || !user) return <LoginPage api={api}/>

  return <PlatformShell view={view} search={search} user={user} onSearch={setSearch} onView={openView} onLogout={() => void api.logout()} showIntegrationPreview={integrationPreviewEnabled}>
    {view === 'uploads'
      ? <UploadsPage api={api} />
      : view === 'integration-preview' && integrationPreviewEnabled
        ? IntegrationPreviewPage && <Suspense fallback={<div className="route-loading" role="status">正在打开媒体验证台…</div>}><IntegrationPreviewPage api={api} onReturnToLibrary={() => openView('home')} /></Suspense>
        : <MyVideosPage api={api} search={deferredSearch} onUpload={() => openView('uploads')} />}
  </PlatformShell>
}
