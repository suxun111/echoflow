import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('V1 Prisma baseline', () => {
  const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8')

  it('contains every V1 core model', () => {
    for (const model of [
      'User', 'OtpChallenge', 'RefreshSession', 'UploadSession', 'UploadPart', 'MediaAsset', 'MediaObject',
      'ProcessingRun', 'ProcessingChunk', 'OutboxEvent', 'TranscriptVersion', 'SubtitleCue', 'PrivateLesson',
      'LearningUnit', 'LearningProgress', 'AuditEvent', 'IdempotencyRecord',
    ]) expect(schema).toContain(`model ${model} `)
  })

  it('targets PostgreSQL and uses BigInt for media sizes', () => {
    expect(schema).toContain('provider = "postgresql"')
    expect(schema).toContain('sizeBytes       BigInt')
  })

  it('excludes retired public-learning models and roles', () => {
    for (const retired of ['Favorite', 'VocabularyItem', 'Recording', 'AuthorizationReview', 'EDITOR', 'TRANSLATE']) {
      expect(schema).not.toContain(retired)
    }
  })
})
