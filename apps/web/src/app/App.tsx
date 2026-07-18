import { lazy, Suspense, useCallback, useDeferredValue, useState } from 'react'
import type { LibraryVideo } from '../data/library'
import type { AppView } from '../types'
import { PlatformShell } from '../components/PlatformShell'
import { LibraryPage } from '../features/library/LibraryPage'
import { UploadModal, UploadsPage } from '../features/uploads/UploadsPage'

const PracticePage = lazy(() => import('../features/learning/PracticePage').then((module) => ({ default: module.PracticePage })))
const AccountPage = lazy(() => import('../features/account/AccountPage').then((module) => ({ default: module.AccountPage })))

function RouteLoading() {
  return <div className="route-loading" role="status">正在加载页面…</div>
}

export default function App() {
  const [view, setView] = useState<AppView>('home')
  const [search, setSearch] = useState('')
  const [activeVideo, setActiveVideo] = useState<LibraryVideo | null>(null)
  const [favorites, setFavorites] = useState(() => new Set<string>(['new-york-coffee', 'scotland-train']))
  const [showUpload, setShowUpload] = useState(false)
  const deferredSearch = useDeferredValue(search)

  const toggleFavorite = useCallback((id: string) => setFavorites((current) => {
    const next = new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  }), [])
  const openView = useCallback((next: AppView) => { setView(next); setActiveVideo(null); window.scrollTo(0, 0) }, [])
  const openVideo = useCallback((video: LibraryVideo) => { setActiveVideo(video); window.scrollTo(0, 0) }, [])

  if (activeVideo) return <Suspense fallback={<RouteLoading/>}><PracticePage video={activeVideo} favorite={favorites.has(activeVideo.id)} onFavorite={() => toggleFavorite(activeVideo.id)} onBack={() => setActiveVideo(null)} /></Suspense>

  return <PlatformShell view={view} search={search} onSearch={setSearch} onView={openView} onUpload={() => setShowUpload(true)}>
    {(['home', 'discover', 'favorites'] as AppView[]).includes(view)
      ? <LibraryPage view={view} search={deferredSearch} favorites={favorites} onFavorite={toggleFavorite} onOpen={openVideo} />
      : view === 'uploads'
        ? <UploadsPage onUpload={() => setShowUpload(true)} />
        : <Suspense fallback={<RouteLoading/>}><AccountPage view={view} /></Suspense>}
    {showUpload && <UploadModal onClose={() => setShowUpload(false)} onOpenUploads={() => { setShowUpload(false); openView('uploads') }} />}
  </PlatformShell>
}
