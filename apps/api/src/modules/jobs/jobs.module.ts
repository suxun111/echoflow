import { Controller, Get, Inject, Injectable, Module, NotFoundException, Param } from '@nestjs/common'
import type { ProcessingJob } from '@online-learning/contracts'

@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, ProcessingJob>()
  create(uploadId: string, type: ProcessingJob['type'] = 'transcode') {
    const job: ProcessingJob = { id: crypto.randomUUID(), uploadId, type, status: 'queued', progress: 0, error: null, updatedAt: new Date().toISOString() }
    this.jobs.set(job.id, job)
    return job
  }
  list() { return [...this.jobs.values()] }
  get(id: string) { const job = this.jobs.get(id); if (!job) throw new NotFoundException('任务不存在'); return job }
}

@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}
  @Get() list() { return this.jobs.list() }
  @Get(':id') get(@Param('id') id: string) { return this.jobs.get(id) }
}

@Module({ controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
