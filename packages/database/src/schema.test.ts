import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('V1 Prisma baseline', () => {
  const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8')
  const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260812000100_v1_baseline/migration.sql'), 'utf8')
  const g2Migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260812000200_g2_upload_metadata/migration.sql'), 'utf8')
  const g3Migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260813000100_g3_moss_transcript/migration.sql'), 'utf8')

  it('contains every V1 core model', () => {
    for (const model of [
      'User', 'OtpChallenge', 'RefreshSession', 'UploadSession', 'UploadPart', 'MediaAsset', 'MediaObject',
      'ProcessingRun', 'ProcessingChunk', 'OutboxEvent', 'TranscriptVersion', 'SubtitleCue', 'PrivateLesson',
      'LearningUnit', 'LearningProgress', 'AuditEvent', 'IdempotencyRecord', 'MossCallbackReceipt',
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

  it('freezes PRD states and owner/aggregate database constraints', () => {
    expect(migration).toContain("CREATE TYPE \"MediaAssetStatus\" AS ENUM ('PROCESSING_PLAYBACK', 'PLAYABLE'")
    expect(migration).toContain("CREATE TYPE \"ProcessingStatus\" AS ENUM ('QUEUED', 'PROCESSING', 'VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED')")
    expect(migration).toContain("CREATE TYPE \"TranscriptStatus\" AS ENUM ('BUILDING', 'ACTIVE', 'SUPERSEDED', 'REJECTED')")
    for (const constraint of [
      'MediaAsset_uploadSessionId_ownerId_fkey',
      'ProcessingRun_mediaAssetId_ownerId_fkey',
      'PrivateLesson_mediaAssetId_ownerId_fkey',
      'PrivateLesson_transcriptVersionId_mediaAssetId_fkey',
      'LearningProgress_lessonId_ownerId_fkey',
      'LearningProgress_currentUnitId_lessonId_fkey',
      'LearningProgress_currentCueId_currentTranscriptVersionId_fkey',
      'TranscriptVersion_one_active_per_media',
    ]) expect(migration).toContain(constraint)
  })

  it('recreates only a dedicated test database and protects the legacy migration target', () => {
    const prepare = readFileSync(resolve(__dirname, '../scripts/prepare-test-database.ts'), 'utf8')
    const runner = readFileSync(resolve(__dirname, '../scripts/run-migration.ts'), 'utf8')
    expect(prepare).toContain('^echoflow_[A-Za-z0-9_]+_test$')
    expect(prepare).toContain('DROP DATABASE IF EXISTS')
    expect(runner).toContain("databaseName === 'online_learning'")
    expect(runner).toContain('Refusing to migrate protected legacy database')
  })

  it('generates the Prisma Client before compiling a fresh workspace', () => {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts.build).toBe('prisma generate && tsc -p tsconfig.json')
  })

  it('adds G2 resume identity and object evidence without rewriting the baseline', () => {
    expect(schema).toContain('fileFingerprint  String?')
    expect(schema).toContain('etag           String?')
    expect(g2Migration).toContain('UploadSession_ownerId_fileFingerprint_idx')
    expect(g2Migration).toContain('UploadSession_fingerprint_check')
    expect(g2Migration).toContain('ADD COLUMN "etag"')
  })

  it('adds durable G3 MOSS identity, replay protection and transcript provenance', () => {
    expect(schema).toContain('idempotencyKey  String')
    expect(schema).toContain('externalJobId   String?          @unique')
    expect(schema).toContain('model MossCallbackReceipt')
    expect(schema).toContain('processingRunId String         @unique')
    expect(schema).toContain('purgedAt       DateTime?')
    expect(g3Migration).toContain('ProcessingRun_mediaAssetId_pipelineVersion_key')
    expect(g3Migration).toContain('ProcessingRun_id_mediaAssetId_key')
    expect(g3Migration).toContain('ProcessingChunk_externalJobId_key')
    expect(g3Migration).toContain('MossCallbackReceipt_nonce_key')
    expect(g3Migration).toContain('G3 migration requires an empty pre-G3 TranscriptVersion table')
    expect(g3Migration).toContain('FOREIGN KEY ("processingRunId", "mediaAssetId")')
  })
})
