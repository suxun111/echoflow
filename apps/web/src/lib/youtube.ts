export function getYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') return url.searchParams.get('v')
      const match = url.pathname.match(/^\/(embed|shorts|live)\/([^/?#]+)/)
      return match?.[2] || null
    }
  } catch {
    return null
  }
  return null
}

export function getYouTubeEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&rel=0`
}
