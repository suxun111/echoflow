import { Controller, Get, Inject, Injectable, Module, Param } from '@nestjs/common'
import { PrivateLessonSchema } from '@online-learning/contracts'
import { ApiException } from '../../common/api-exception'
import { CurrentUser } from '../../common/auth.decorators'
import { DatabaseService } from '../../database/database.module'
import type { AuthenticatedUser } from '../auth/auth.types'

@Injectable()
export class LessonsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async getOwned(lessonId: string, ownerId: string) {
    const lesson = await this.database.privateLesson.findFirst({ where: { id: lessonId, ownerId } })
    if (!lesson) throw new ApiException(404, 'not_found', '学习内容不存在')
    return PrivateLessonSchema.parse({
      id: lesson.id,
      title: lesson.title,
      status: lesson.status.toLowerCase(),
      mediaAssetId: lesson.mediaAssetId,
      transcriptVersionId: lesson.transcriptVersionId,
      createdAt: lesson.createdAt.toISOString(),
      updatedAt: lesson.updatedAt.toISOString(),
    })
  }
}

@Controller('lessons')
export class LessonsController {
  constructor(@Inject(LessonsService) private readonly lessons: LessonsService) {}

  @Get(':lessonId')
  get(@Param('lessonId') lessonId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.lessons.getOwned(lessonId, user.id)
  }
}

@Module({ controllers: [LessonsController], providers: [LessonsService] })
export class LessonsModule {}
