import { Body, Controller, Get, Inject, Injectable, Module, Param, Put, UseGuards } from '@nestjs/common'
import { ProgressUpdateSchema, type ProgressUpdate } from '@online-learning/contracts'
import { DatabaseService } from '@online-learning/database'
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth/auth.module'

@Injectable()
export class ProgressService {
  // Test-only fallback; production and development use LearningProgress.
  private readonly testStore = new Map<string, ProgressUpdate>()

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(userId: string, lessonId: string) {
    if (process.env.NODE_ENV === 'test') return this.testStore.get(`${userId}:${lessonId}`) ?? { lessonId, completedCueIds: [], positionMs: 0 }
    const progress = await this.database.learningProgress.findUnique({ where: { userId_lessonId: { userId, lessonId } } })
    return progress ? { lessonId, currentCueId: progress.currentCueId ?? undefined, completedCueIds: Array.isArray(progress.completedCueIds) ? progress.completedCueIds as string[] : [], positionMs: progress.positionMs } : { lessonId, completedCueIds: [], positionMs: 0 }
  }

  async update(userId: string, lessonId: string, input: unknown) {
    const value = ProgressUpdateSchema.parse({ ...(input as object), lessonId })
    if (process.env.NODE_ENV === 'test') {
      this.testStore.set(`${userId}:${lessonId}`, value)
      return value
    }
    const progress = await this.database.learningProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      update: { currentCueId: value.currentCueId ?? null, completedCueIds: value.completedCueIds, positionMs: value.positionMs },
      create: { userId, lessonId, currentCueId: value.currentCueId, completedCueIds: value.completedCueIds, positionMs: value.positionMs },
    })
    return { lessonId, currentCueId: progress.currentCueId ?? undefined, completedCueIds: progress.completedCueIds as string[], positionMs: progress.positionMs }
  }
}

@Controller('progress')
@UseGuards(AuthGuard)
export class ProgressController {
  constructor(@Inject(ProgressService) private readonly progress: ProgressService) {}
  @Get(':lessonId') get(@Param('lessonId') lessonId: string, @CurrentUser() user: AuthenticatedUser) { return this.progress.get(user.id, lessonId) }
  @Put(':lessonId') update(@Param('lessonId') lessonId: string, @Body() input: unknown, @CurrentUser() user: AuthenticatedUser) { return this.progress.update(user.id, lessonId, input) }
}

@Module({ controllers: [ProgressController], providers: [ProgressService] })
export class ProgressModule {}
