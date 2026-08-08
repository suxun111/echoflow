import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Prisma domain schema', () => {
  const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8')
  it('contains every core domain model', () => {
    for (const model of ['User', 'VideoAsset', 'Lesson', 'SubtitleCue', 'LearningProgress', 'Favorite', 'VocabularyItem', 'Recording', 'Upload', 'ProcessingJob', 'AuthorizationReview', 'VerificationCode']) {
      expect(schema).toContain(`model ${model} `)
    }
  })
  it('targets PostgreSQL', () => expect(schema).toContain('provider = "postgresql"'))
  it('enforces one processing job per upload stage', () => expect(schema).toContain('@@unique([uploadId, type])'))
  it('tracks upload completion before queueing work', () => expect(schema).toContain('completedAt     DateTime?'))
  it('tracks dependency failures without losing progress', () => {
    expect(schema).toContain('WAITING_DEPENDENCY')
    expect(schema).toContain('stage     String?')
    expect(schema).toContain('errorCode String?')
    expect(schema).toContain('lastAttemptAt DateTime?')
    expect(schema).toContain('failedAt DateTime?')
  })
})
