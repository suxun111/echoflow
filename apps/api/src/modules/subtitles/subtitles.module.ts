import { Body, Controller, Get, Module, Param, Put } from '@nestjs/common'
import { SubtitleCueSchema } from '@online-learning/contracts'

@Controller('subtitles')
export class SubtitlesController {
  @Get(':lessonId') list(@Param('lessonId') lessonId: string) { return { lessonId, version: 1, cues: [] } }
  @Put(':lessonId/:cueId') update(@Param('lessonId') lessonId: string, @Param('cueId') cueId: string, @Body() input: unknown) { return { lessonId, ...SubtitleCueSchema.parse({ ...(input as object), id: cueId }) } }
}

@Module({ controllers: [SubtitlesController] })
export class SubtitlesModule {}
