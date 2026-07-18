import { Body, Controller, Get, Module, Param, Put } from '@nestjs/common'
import { ProgressUpdateSchema, type ProgressUpdate } from '@online-learning/contracts'

const progressStore = new Map<string, ProgressUpdate>()

@Controller('progress')
export class ProgressController {
  @Get(':lessonId') get(@Param('lessonId') lessonId: string) { return progressStore.get(lessonId) ?? { lessonId, completedCueIds: [], positionMs: 0 } }
  @Put(':lessonId') update(@Param('lessonId') lessonId: string, @Body() input: unknown) { const value = ProgressUpdateSchema.parse({ ...(input as object), lessonId }); progressStore.set(lessonId, value); return value }
}

@Module({ controllers: [ProgressController] })
export class ProgressModule {}
