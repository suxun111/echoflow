import { Body, Controller, Get, Module, Param, Post, UseGuards } from '@nestjs/common'
import { AdminReviewSchema } from '@online-learning/contracts'
import { AuthGuard, RateLimitGuard, Roles, RolesGuard } from '../auth/auth.module'

@Controller('admin')
@UseGuards(AuthGuard, RolesGuard, RateLimitGuard)
@Roles('admin', 'editor')
export class AdminController {
  @Get('candidates') candidates() { return [{ id: 'candidate-1', title: 'Slow Travel English', source: 'YouTube metadata', status: 'rights_review' }] }
  @Post('assets/:id/review') review(@Param('id') id: string, @Body() input: unknown) { return { assetId: id, ...AdminReviewSchema.parse(input), reviewedAt: new Date().toISOString() } }
  @Post('lessons/:id/publish') publish(@Param('id') id: string) { return { lessonId: id, status: 'published', publishedAt: new Date().toISOString() } }
}

@Module({ controllers: [AdminController] })
export class AdminModule {}
