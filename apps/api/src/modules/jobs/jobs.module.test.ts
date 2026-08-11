import { describe, expect, it } from 'vitest'
import { toProcessingJob, toTranslationCoverage } from './jobs.module'

describe('persistent job response mapping', () => {
  it('returns the worker stage and non-blocking warnings stored with a database job', () => {
    expect(toProcessingJob({
      id: 'job-1',
      uploadId: 'upload-1',
      type: 'TRANSCRIBE',
      status: 'PROCESSING',
      progress: 62,
      error: null,
      payload: { stage: 'moss-transcribing', warnings: ['翻译服务暂不可用'] },
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    })).toEqual({
      id: 'job-1',
      uploadId: 'upload-1',
      type: 'transcribe',
      status: 'processing',
      progress: 62,
      stage: 'moss-transcribing',
      warnings: ['翻译服务暂不可用'],
      error: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
      translatedCount: 0,
      totalCount: 0,
    })
  })

  it('reports partial translation coverage without claiming completion', () => {
    expect(toTranslationCoverage(97, 4, ['RATE_LIMITED: 火山翻译请求受限'])).toEqual({
      translatedCount: 4,
      totalCount: 97,
      missingCount: 93,
      status: 'partial',
      warnings: ['RATE_LIMITED: 火山翻译请求受限'],
    })
  })
})
