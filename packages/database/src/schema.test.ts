import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('V1 Prisma baseline', () => {
  const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8')
  const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260812000100_v1_baseline/migration.sql'), 'utf8')
  const g2Migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260812000200_g2_upload_metadata/migration.sql'), 'utf8')
  const g3Migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260813000100_g3_moss_transcript/migration.sql'), 'utf8')
  const g3PlanRevisionMigration = readFileSync(resolve(__dirname, '../prisma/migrations/20260822000100_g3_plan_revision_repair/migration.sql'), 'utf8')

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

  it('adds one bounded immutable G3 replan overlay without rewriting old chunks', () => {
    expect(schema).toContain('activePlanRevision Int             @default(0)')
    expect(schema).toContain('pendingPlanRevision Int?')
    expect(schema).toContain('planRevision    Int              @default(0)')
    expect(schema).toContain('inputChecksum   String?          @db.Char(64)')
    expect(schema).toContain('@@unique([processingRunId, planRevision, chunkIndex])')
    expect(g3PlanRevisionMigration).toContain('ProcessingRun_plan_revision_check')
    expect(g3PlanRevisionMigration).toContain('BETWEEN 0 AND 1')
    expect(g3PlanRevisionMigration).toContain('"pendingPlanRevision" BETWEEN 0 AND 1')
    expect(g3PlanRevisionMigration).toContain('ProcessingChunk_plan_identity_check')
    expect(g3PlanRevisionMigration).toContain('prevent_processing_chunk_identity_mutation')
    expect(g3PlanRevisionMigration).toContain('OLD."processingRunId" IS DISTINCT FROM NEW."processingRunId"')
    expect(g3PlanRevisionMigration).toContain('OLD."resultObjectKey" IS NOT NULL')
  })

  describe('G3 v2 deterministic foundation migration', () => {
    const v2Migration = readFileSync(resolve(__dirname, '../prisma/migrations/20260826000100_g3_v2_deterministic_foundation/migration.sql'), 'utf8')

    it('adds v2 entities and enum values without touching historical migrations', () => {
      for (const model of ['ProcessingHandoff', 'HandoffAssessment', 'AlignmentJob', 'HandoffEvidence']) {
        expect(schema).toContain(`model ${model} `)
        expect(v2Migration).toContain(`CREATE TABLE "${model}"`)
      }
      expect(v2Migration).toContain("ALTER TYPE \"MediaObjectKind\" ADD VALUE IF NOT EXISTS 'HANDOFF_AUDIO'")
      expect(v2Migration).toContain("ALTER TYPE \"MediaObjectKind\" ADD VALUE IF NOT EXISTS 'ALIGNMENT_RAW'")
      expect(v2Migration).toContain("ALTER TYPE \"ProcessingStage\" ADD VALUE IF NOT EXISTS 'HANDOFF_EVIDENCING'")
    })

    it('persists the seven H_* counts on TranscriptVersion with DB-level equalities and hProviderWord=0', () => {
      for (const field of ['hTotal', 'hUnique', 'hR1', 'hUnresolved', 'hSegment', 'hProviderWord', 'hAlignment']) {
        expect(schema).toMatch(new RegExp(`${field}\\s+Int\\s+@default\\(0\\)`))
      }
      expect(v2Migration).toContain('ADD COLUMN "hTotal" INTEGER NOT NULL DEFAULT 0')
      expect(v2Migration).toContain('TranscriptVersion_h_counts_check')
      expect(v2Migration).toContain('"hUnique" + "hR1" + "hUnresolved" = "hTotal"')
      expect(v2Migration).toContain('"hSegment" + "hProviderWord" + "hAlignment" = "hUnique" + "hR1"')
      expect(v2Migration).toContain('"hProviderWord" = 0')
    })

    it('freezes handoff identity, adjacency, revision and validity at the database level', () => {
      expect(v2Migration).toContain('ProcessingHandoff_processingRunId_planRevision_logicalHandoffIndex_key')
      expect(v2Migration).toContain('ProcessingChunk_id_processingRunId_key')
      expect(v2Migration).toContain('"previousChunkId" <> "nextChunkId"')
      expect(v2Migration).toContain('validate_processing_handoff_chunks')
      expect(v2Migration).toContain("IF prev_chunk.\"chunkIndex\" + 1 <> next_chunk.\"chunkIndex\"")
      expect(v2Migration).toContain('prevent_processing_handoff_identity_mutation')
    })

    it('keeps assessments non-terminal and final evidence terminal and immutable', () => {
      expect(v2Migration).toContain('HandoffAssessment_handoffId_key')
      expect(v2Migration).toContain('prevent_handoff_assessment_mutation')
      expect(v2Migration).toContain('HandoffEvidence_handoffId_key')
      expect(v2Migration).toContain('prevent_handoff_evidence_mutation')
      expect(v2Migration).toContain('HandoffEvidence is final and immutable')
    })

    it('freezes the accepted evidenceType whitelist and alignment job boundaries', () => {
      expect(v2Migration).toContain('"evidenceType" IN (\'strict_segment\', \'boundary_forced_alignment\')')
      expect(v2Migration).toContain('alignment_unavailable')
      expect(v2Migration).toContain('AlignmentJob_identity_check')
      expect(v2Migration).toContain('"attempt" BETWEEN 0 AND 3')
      expect(v2Migration).toContain('prevent_alignment_job_identity_mutation')
      expect(v2Migration).toContain('externalJobId is set-once')
    })
  })
})
