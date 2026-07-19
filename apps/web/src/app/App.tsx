import { lazy, Suspense, useCallback, useDeferredValue, useState } from 'react'
import type { LibraryVideo } from '../data/library'
import type { AppView, AuthSession } from '../types'
import { PlatformShell } from '../components/PlatformShell'
import { LibraryPage } from '../features/library/LibraryPage'
import { UploadModal, UploadsPage } from '../features/uploads/UploadsPage'
import { AuthPage } from '../features/auth/AuthPage'
import { clearAuthSession, loadAuthSession, saveAuthSession } from '../lib/authSession'

const PracticePage = lazy(() => import('../features/learning/PracticePage').then((module) => ({ default: module.PracticePage })))
const AccountPage = lazy(() => import('../features/account/AccountPage').then((module) => ({ default: module.AccountPage })))
const protectedViews = new Set<AppView>(['favorites', 'history', 'vocabulary', 'uploads', 'settings'])

function RouteLoading() {
  return <div className="route-loading" role="status">正在加载页面…</div>
}

export default function App() {
  const [view, setView] = useState<AppView>('home')
  const [search, setSearch] = useState('')
  const [activeVideo, setActiveVideo] = useState<LibraryVideo | null>(null)
  const [favorites, setFavorites] = useState(() => new Set<string>(['new-york-coffee', 'scotland-train']))
  const [showUpload, setShowUpload] = useState(false)
  const [session, setSession] = useState<AuthSession | null>(() => loadAuthSession())
  const [showAuth, setShowAuth] = useState(false)
  const [pendingView, setPendingView] = useState<AppView | null>(null)
  const deferredSearch = useDeferredValue(search)

  const toggleFavorite = useCallback((id: string) => setFavorites((current) => {
    const next = new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  }), [])
  const openAuth = useCallback((next?: AppView) => {
    if (next) setPendingView(next)
    setActiveVideo(null)
    setShowUpload(false)
    setShowAuth(true)
    window.scrollTo(0, 0)
  }, [])
  const openView = useCallback((next: AppView) => {
    if (!session && protectedViews.has(next)) {
      openAuth(next)
      return
    }
    setView(next); setActiveVideo(null); window.scrollTo(0, 0)
  }, [openAuth, session])
  const openVideo = useCallback((video: LibraryVideo) => { setActiveVideo(video); window.scrollTo(0, 0) }, [])
  const handleAuthenticated = useCallback((nextSession: AuthSession) => {
    saveAuthSession(nextSession)
    setSession(nextSession)
    setShowAuth(false)
    if (pendingView) {
      setView(pendingView)
      setPendingView(null)
    }
    window.scrollTo(0, 0)
  }, [pendingView])
  const handleSignOut = useCallback(() => {
    clearAuthSession()
    setSession(null)
    setView('home')
    setActiveVideo(null)
    setShowUpload(false)
    setShowAuth(true)
    window.scrollTo(0, 0)
  }, [])
  const handleUpload = useCallback(() => {
    if (!session) {
      openAuth('uploads')
      return
    }
    setShowUpload(true)
  }, [openAuth, session])

  if (activeVideo) return <Suspense fallback={<RouteLoading/>}><PracticePage video={activeVideo} favorite={favorites.has(activeVideo.id)} onFavorite={() => toggleFavorite(activeVideo.id)} onBack={() => setActiveVideo(null)} /></Suspense>

  if (showAuth) return <AuthPage onAuthenticated={handleAuthenticated} onCancel={session ? undefined : () => { setShowAuth(false); setPendingView(null) }}/>

  return <PlatformShell view={view} search={search} user={session?.user ?? null} onSearch={setSearch} onView={openView} onUpload={handleUpload} onAuth={() => openAuth()} onSignOut={handleSignOut}>
    {(['home', 'discover', 'favorites'] as AppView[]).includes(view)
      ? <LibraryPage view={view} search={deferredSearch} favorites={favorites} onFavorite={toggleFavorite} onOpen={openVideo} />
      : view === 'uploads'
        ? <UploadsPage onUpload={() => setShowUpload(true)} />
        : <Suspense fallback={<RouteLoading/>}><AccountPage view={view} /></Suspense>}
    {showUpload && <UploadModal onClose={() => setShowUpload(false)} onOpenUploads={() => { setShowUpload(false); openView('uploads') }} />}
  </PlatformShell>
}
