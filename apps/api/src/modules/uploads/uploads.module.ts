import { Body, Controller, Inject, Module, Post } from '@nestjs/common'
import { UploadRequestSchema } from '@online-learning/contracts'
import { MemoryStorageProvider } from '@online-learning/storage'
import { JobsModule, JobsService } from '../jobs/jobs.module'

@Controller('uploads')
export class UploadsController {
  private readonly storage = new MemoryStorageProvider()
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}
  @Post('presign') async presign(@Body() input: unknown) {
    const data = UploadRequestSchema.parse(input)
    const target = await this.storage.createUploadTarget(data.fileName, data.contentType)
    const uploadId = crypto.randomUUID()
    return { uploadId, private: true, ...target, firstJob: this.jobs.create(uploadId) }
  }
}

@Module({ imports: [JobsModule], controllers: [UploadsController] })
export class UploadsModule {}
