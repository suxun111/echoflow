import { Module } from '@nestjs/common'
import { HealthModule } from './modules/health/health.module'
import { AuthModule } from './modules/auth/auth.module'
import { UsersModule } from './modules/users/users.module'
import { VideosModule } from './modules/videos/videos.module'
import { LessonsModule } from './modules/lessons/lessons.module'
import { SubtitlesModule } from './modules/subtitles/subtitles.module'
import { ProgressModule } from './modules/progress/progress.module'
import { UploadsModule } from './modules/uploads/uploads.module'
import { JobsModule } from './modules/jobs/jobs.module'
import { AdminModule } from './modules/admin/admin.module'

@Module({ imports: [HealthModule, AuthModule, UsersModule, VideosModule, LessonsModule, SubtitlesModule, ProgressModule, UploadsModule, JobsModule, AdminModule] })
export class AppModule {}
