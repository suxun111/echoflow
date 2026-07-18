import { Controller, Get, Inject, Injectable, Module, Param, Query } from '@nestjs/common'
import { VideoQuerySchema, type VideoSummary } from '@online-learning/contracts'

export const demoVideos: VideoSummary[] = [
  { id: 'british-coast', title: '英国海滨小镇的一天', subtitle: 'Life in a British Coastal Town', creator: 'Evie English', level: 'A2', category: '旅行', accent: '英音', durationSeconds: 522, coverUrl: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1200&q=85', published: true },
  { id: 'new-york-coffee', title: '在纽约点一杯咖啡', subtitle: 'How to Order Coffee Naturally', creator: 'Speak Easy', level: 'A2', category: '日常', accent: '美音', durationSeconds: 326, coverUrl: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=85', published: true },
]

@Injectable()
export class VideosService {
  list(raw: Record<string, unknown>) {
    const query = VideoQuerySchema.parse(raw)
    const filtered = demoVideos.filter((video) => (!query.search || `${video.title}${video.subtitle}${video.creator}`.toLowerCase().includes(query.search.toLowerCase())) && (!query.level || video.level === query.level) && (!query.category || video.category === query.category) && (!query.accent || video.accent === query.accent))
    return { items: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), page: query.page, pageSize: query.pageSize, total: filtered.length }
  }
  get(id: string) { return demoVideos.find((video) => video.id === id) ?? null }
}

@Controller('videos')
export class VideosController {
  constructor(@Inject(VideosService) private readonly videos: VideosService) {}
  @Get() list(@Query() query: Record<string, unknown>) { return this.videos.list(query) }
  @Get(':id') get(@Param('id') id: string) { return this.videos.get(id) }
}

@Module({ controllers: [VideosController], providers: [VideosService], exports: [VideosService] })
export class VideosModule {}
