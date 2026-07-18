import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Prisma domain schema', () => {
  const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8')
  it('contains every core domain model', () => {
    for (const model of ['User', 'VideoAsset', 'Lesson', 'SubtitleCue', 'LearningProgress', 'Favorite', 'VocabularyItem', 'Recording', 'Upload', 'ProcessingJob', 'AuthorizationReview']) {
      expect(schema).toContain(`model ${model} `)
    }
  })
  it('targets PostgreSQL', () => expect(schema).toContain('provider = "postgresql"'))
})
