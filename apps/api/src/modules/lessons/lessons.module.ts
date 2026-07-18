import { Controller, Get, Module, Param } from '@nestjs/common'

const cues = [
  { id: 'cue-1', startMs: 2000, endMs: 5000, english: 'Welcome back to another slow English video.', chinese: '欢迎回到又一期慢速英语视频。', keywords: ['welcome', 'slow English'], reviewed: true },
  { id: 'cue-2', startMs: 5000, endMs: 9000, english: 'Today, I am taking you around my little coastal town.', chinese: '今天，我会带你逛逛我居住的海滨小镇。', keywords: ['coastal town'], reviewed: true },
]

@Controller('lessons')
export class LessonsController {
  @Get(':id') get(@Param('id') id: string) { return { id, title: '英国海滨小镇的一天', subtitle: 'Life in a British Coastal Town', creator: 'Evie English', level: 'A2', category: '旅行', accent: '英音', durationSeconds: 522, coverUrl: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1200&q=85', published: true, description: '跟随慢速英语漫步英国海滨小镇。', playbackUrl: null, cues } }
}

@Module({ controllers: [LessonsController] })
export class LessonsModule {}
