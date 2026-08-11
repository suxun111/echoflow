import { memo, useCallback, useMemo, useState } from 'react'
import type { AppView } from '../../types'
import { filterGroups, libraryVideos, type LibraryVideo } from '../../data/library'
import { Icon } from '../../components/Icon'
import { LearningStreak } from '../../components/LearningStreak'

function coverUrl(source: string, width: number): string {
  try {
    const url = new URL(source)
    if (url.hostname !== 'images.unsplash.com') return source
    url.searchParams.set('auto', 'format')
    url.searchParams.set('fit', 'crop')
    url.searchParams.set('w', String(width))
    url.searchParams.set('q', width >= 1200 ? '82' : '76')
    return url.toString()
  } catch {
    return source
  }
}

function coverSrcSet(source: string, widths: number[]): string {
  return widths.map((width) => `${coverUrl(source, width)} ${width}w`).join(', ')
}

const VideoCard = memo(function VideoCard({ video, saved, onSave, onOpen }: { video: LibraryVideo; saved: boolean; onSave: (id: string) => void; onOpen: (video: LibraryVideo) => void }) {
  const open = useCallback(() => onOpen(video), [onOpen, video])
  const save = useCallback(() => onSave(video.id), [onSave, video.id])

  return <article className="video-card"><button className="video-cover" onClick={open}><img className="video-cover-image" src={coverUrl(video.cover, 800)} srcSet={coverSrcSet(video.cover, [480, 800, 1200])} sizes="(max-width: 480px) 100vw, (max-width: 760px) 50vw, (max-width: 1220px) 33vw, 25vw" alt="" loading="lazy" decoding="async"/><span className="cover-shade"/><span className="level-badge">{video.level} · {video.accent}</span><span className="duration">{video.duration}</span><span className="cover-play"><Icon name="play" size={22}/></span>{video.progress !== undefined && <span className="card-progress"><i style={{ width: `${video.progress}%` }}/></span>}</button><div className="video-info"><div className="card-title-row"><button className="title-button" onClick={open}><h3>{video.title}</h3><p>{video.subtitle}</p></button><button className={`favorite ${saved ? 'saved' : ''}`} onClick={save} aria-label={saved ? '取消收藏' : '收藏'}><Icon name="heart" size={19}/></button></div><div className="card-meta"><span className="creator-dot" style={{ background: video.color }}>{video.creator[0]}</span><span>{video.creator}</span><i/><span>{video.category}</span><i/><span>{video.learners} 人学过</span></div></div></article>
})

const Featured = memo(function Featured({ video, onOpen }: { video: LibraryVideo; onOpen: (video: LibraryVideo) => void }) {
  const open = useCallback(() => onOpen(video), [onOpen, video])

  return <><section className="featured-banner"><img src={coverUrl(video.cover, 1600)} srcSet={coverSrcSet(video.cover, [800, 1200, 1600])} sizes="(max-width: 760px) calc(100vw - 32px), (max-width: 980px) calc(100vw - 152px), calc(100vw - 320px)" alt="英国海滨小镇" loading="eager" decoding="async" fetchPriority="high"/><div className="featured-overlay"/><div className="featured-copy"><span className="editor-pick"><Icon name="sparkles" size={15}/> 本周精选</span><p>TRAVEL · SLOW ENGLISH</p><h1>沿着英国海岸，<br/>练一口自然英语</h1><span className="feature-desc">8 分钟沉浸式小镇漫步 · A2 难度 · 英式发音</span><button onClick={open}><Icon name="play" size={18}/>开始学习</button></div><div className="featured-stats"><span><strong>4.9</strong> 学员评分</span><span><strong>2.8k</strong> 人已学习</span><span><strong>32</strong> 个实用表达</span></div></section><section className="continue-card"><div className="continue-thumb"><img src={coverUrl(video.cover, 320)} alt="" loading="lazy" decoding="async"/><button onClick={open}><Icon name="play"/></button></div><div className="continue-content"><span>继续学习</span><h3>{video.title}</h3><p>第 12 / 32 句 · 上次学习于昨天</p><div className="continue-progress"><i style={{ width: `${video.progress}%` }}/></div></div><div className="continue-percent"><strong>{video.progress}%</strong><button onClick={open}>继续 →</button></div></section></>
})

export function LibraryPage({ view, search, onOpen, favorites, onFavorite }: { view: AppView; search: string; onOpen: (video: LibraryVideo) => void; favorites: Set<string>; onFavorite: (id: string) => void }) {
  const [filters, setFilters] = useState({ 难度: '全部', 主题: '全部', 口音: '全部' })
  const videos = useMemo(() => libraryVideos.filter((video) => {
    const query = search.trim().toLowerCase()
    return (!query || [video.title, video.subtitle, video.creator, video.category].some((value) => value.toLowerCase().includes(query))) && (filters.难度 === '全部' || video.level === filters.难度) && (filters.主题 === '全部' || video.category === filters.主题) && (filters.口音 === '全部' || video.accent === filters.口音) && (view !== 'favorites' || favorites.has(video.id))
  }), [search, filters, view, favorites])
  const featured = libraryVideos[0]
  return <main className="library-page">{view === 'home' && <><div className="welcome-row"><div><p>FRIDAY, JULY 17</p><h2>早上好，Lena <span>👋</span></h2><small>今天想从哪段英语开始？</small></div><LearningStreak/></div><Featured video={featured} onOpen={onOpen}/></>}<section className="catalogue"><div className="catalogue-heading"><div><p>{view === 'favorites' ? 'MY FAVORITES' : 'CURATED FOR YOU'}</p><h2>{view === 'favorites' ? '我的收藏' : view === 'discover' ? '发现全部课程' : '为你精选'}</h2></div><span>{videos.length} 个视频</span></div><div className="filter-bar">{Object.entries(filterGroups).map(([group, values]) => <div className="filter-group" key={group}><strong>{group}</strong>{values.map((value) => <button key={value} className={filters[group as keyof typeof filters] === value ? 'active' : ''} onClick={() => setFilters({ ...filters, [group]: value })}>{value}</button>)}</div>)}</div>{videos.length ? <div className="video-grid">{videos.map((video) => <VideoCard key={video.id} video={video} saved={favorites.has(video.id)} onSave={onFavorite} onOpen={onOpen}/>)}</div> : <div className="blank-state"><Icon name="heart" size={32}/><h3>这里还没有内容</h3><p>收藏喜欢的视频，稍后会显示在这里。</p></div>}</section></main>
}
