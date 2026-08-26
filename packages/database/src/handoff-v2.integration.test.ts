import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'

const TEST_DB = 'echoflow_g2_v2_foundation_test'
const TEST_DATABASE_URL = `postgresql://online_learning:online_learning@localhost:5432/${TEST_DB}`

const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')
const uid = () => randomUUID()

let client: Client

async function query(sql: string, params?: unknown[]): Promise<{ ok: boolean; err: string }> {
  try {
    await client.query(sql, params)
    return { ok: true, err: '' }
  } catch (error) {
    return { ok: false, err: (error as Error).message.split('\n')[0]! }
  }
}

interface Fixture {
  userId: string
  assetId: string
  runV1: string
  runV2: string
  chunks: Record<string, { id: string; index: number }>
}

async function createFixture(): Promise<Fixture> {
  const userId = uid()
  const assetId = uid()
  const runV1 = uid()
  const runV2 = uid()
  await client.query(
    'INSERT INTO "User" (id, phone, "displayName", "updatedAt") VALUES ($1, $2, $3, now())',
    [userId, `139${randomBytes(4).toString('hex')}00`, 'fixture'],
  )
  await client.query(
    'INSERT INTO "MediaAsset" (id, "ownerId", status, title, "originalName", "updatedAt") VALUES ($1, $2, $3, $4, $4, now())',
    [assetId, userId, 'PLAYABLE', 'fixture-video'],
  )
  for (const run of [runV1, runV2]) {
    await client.query(
      'INSERT INTO "ProcessingRun" (id, "ownerId", "mediaAssetId", "pipelineVersion", status, stage, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, now())',
      [run, userId, assetId, run === runV1 ? 'g3-transcript-v1' : 'g3-transcript-v2', 'SUCCEEDED', 'TRANSCRIPT_READY'],
    )
  }
  const chunks: Fixture['chunks'] = {}
  const mkChunk = async (run: string, index: number, status = 'SUCCEEDED') => {
    const id = uid()
    await client.query(
      'INSERT INTO "ProcessingChunk" (id, "processingRunId", "planRevision", "chunkIndex", status, attempt, "idempotencyKey", "modelVersion", "inputObjectKey", "startMs", "endMs", "updatedAt") VALUES ($1, $2, 0, $3, $4, 0, $5, $6, $7, $8, $9, now())',
      [id, run, index, status, `ik-${randomBytes(8).toString('hex')}`, 'model-v', `obj://${randomBytes(6).toString('hex')}`, index * 1000, (index + 1) * 1000],
    )
    chunks[`${run}:${index}`] = { id, index }
    return id
  }
  for (const index of [0, 1, 2]) await mkChunk(runV1, index)
  await mkChunk(runV1, 3, 'FAILED')
  await mkChunk(runV2, 0)
  await mkChunk(runV2, 1)
  return { userId, assetId, runV1, runV2, chunks }
}

const chunkId = (fixture: Fixture, run: 'runV1' | 'runV2', index: number) =>
  fixture.chunks[`${fixture[run]}:${index}`]!.id

const insertHandoff = (id: string, run: string, revision: number, index: number, prev: string, next: string) =>
  query(
    'INSERT INTO "ProcessingHandoff" (id, "processingRunId", "planRevision", "logicalHandoffIndex", "previousChunkId", "nextChunkId", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
    [id, run, revision, index, prev, next, 'PENDING'],
  )

const evidenceColumns = `
  ("id", "handoffId", "planRevision", "logicalHandoffIndex", decision, "decisionCode", "evidenceType",
   "schemaVersion", "pipelineVersion", "previousChunkId", "nextChunkId",
   "previousAsrObjectKey", "nextAsrObjectKey", "methodProvider", "methodVersion",
   "windowStartMs", "windowEndMs", "candidateCount", "anchorCount", "proofKeyVersion", "proofDigest")`

const insertEvidence = (values: unknown[]) =>
  query(`INSERT INTO "HandoffEvidence" ${evidenceColumns} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, values)

function evidenceArgs(handoffId: string, index: number, overrides: Record<string, unknown> = {}): unknown[] {
  return [
    uid(),
    handoffId,
    overrides.planRevision ?? 0,
    overrides.logicalHandoffIndex ?? index,
    overrides.decision ?? 'accepted',
    overrides.decisionCode ?? 'evidence_accepted',
    overrides.evidenceType ?? 'strict_segment',
    '1',
    'g3-transcript-v2',
    overrides.previousChunkId ?? 'chunk-prev',
    overrides.nextChunkId ?? 'chunk-next',
    'asr://synthetic/left',
    'asr://synthetic/right',
    'mfa',
    '3.3.9',
    overrides.windowStartMs ?? 1000,
    overrides.windowEndMs ?? 2000,
    overrides.candidateCount ?? 1,
    overrides.anchorCount ?? 0,
    'v1',
    hex64('proof'),
  ]
}

describe('G3 v2 deterministic foundation — PostgreSQL integration', () => {
  beforeAll(async () => {
    // The disposable database is created by the package pretest
    // (prepare-test-database.ts echoflow_g2_v2_foundation_test).
    client = new Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
  }, 30_000)

  afterAll(async () => {
    await client?.end()
  })

  it('applies the full forward migration chain on a disposable database', async () => {
    const { rows } = await client.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY started_at')
    const names = rows.map((row) => row.migration_name)
    expect(names).toContain('20260826000100_g3_v2_deterministic_foundation')
    expect(names[names.length - 1]).toBe('20260826000100_g3_v2_deterministic_foundation')
  })

  it('keeps existing v1 rows compatible (H_* default to zero and satisfy the CHECK)', async () => {
    const fixture = await createFixture()
    const result = await query(
      'INSERT INTO "TranscriptVersion" (id, "mediaAssetId", "processingRunId", version, status, "pipelineVersion", "modelVersion", "durationMs") VALUES ($1, $2, $3, 1, $4, $5, $6, 1000)',
      [uid(), fixture.assetId, fixture.runV1, 'BUILDING', 'g3-transcript-v1', 'model-v'],
    )
    expect(result.ok).toBe(true)
    const { rows } = await client.query(
      'SELECT "hTotal", "hUnique", "hR1", "hUnresolved", "hSegment", "hProviderWord", "hAlignment" FROM "TranscriptVersion" WHERE "processingRunId" = $1',
      [fixture.runV1],
    )
    expect(rows[0]).toEqual({
      hTotal: 0, hUnique: 0, hR1: 0, hUnresolved: 0, hSegment: 0, hProviderWord: 0, hAlignment: 0,
    })
  })

  it('enforces handoff key uniqueness per (run, revision, logical index)', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    expect(
      (await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))).ok,
    ).toBe(true)
    const duplicate = await insertHandoff(uid(), fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 1), chunkId(fixture, 'runV1', 2))
    expect(duplicate.ok).toBe(false)
    expect(duplicate.err).toContain('unique')
  })

  it('rejects left/right chunks from another run (cross-run)', async () => {
    const fixture = await createFixture()
    const result = await insertHandoff(uid(), fixture.runV2, 0, 0, chunkId(fixture, 'runV2', 0), chunkId(fixture, 'runV1', 1))
    expect(result.ok).toBe(false)
    expect(result.err).toContain('same processing run')
  })

  it('rejects non-adjacent chunks', async () => {
    const fixture = await createFixture()
    const result = await insertHandoff(uid(), fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 2))
    expect(result.ok).toBe(false)
    expect(result.err).toContain('adjacent')
  })

  it('rejects invalid (non-SUCCEEDED) chunks', async () => {
    const fixture = await createFixture()
    const result = await insertHandoff(uid(), fixture.runV1, 0, 2, chunkId(fixture, 'runV1', 2), chunkId(fixture, 'runV1', 3))
    expect(result.ok).toBe(false)
    expect(result.err).toContain('SUCCEEDED')
  })

  it('rejects a self-referencing handoff', async () => {
    const fixture = await createFixture()
    const result = await insertHandoff(uid(), fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 0))
    expect(result.ok).toBe(false)
  })

  it('rejects a handoff whose chunks belong to a different plan revision', async () => {
    const fixture = await createFixture()
    // Revision 1 handoff must reference revision 1 chunks; the fixture only has revision 0 chunks.
    const result = await insertHandoff(uid(), fixture.runV1, 1, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    expect(result.ok).toBe(false)
    expect(result.err).toContain('plan revision')
  })

  it('freezes ProcessingHandoff identity fields (trigger)', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const result = await query('UPDATE "ProcessingHandoff" SET "planRevision" = 1 WHERE id = $1', [h0])
    expect(result.ok).toBe(false)
    expect(result.err).toContain('immutable identity fields')
  })

  it('keeps HandoffAssessment immutable and non-final (trigger)', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const insert = await query(
      'INSERT INTO "HandoffAssessment" (id, "handoffId", decision, "decisionCode", "evidenceType", "inputChecksum", "windowStartMs", "windowEndMs") VALUES ($1, $2, $3, $4, $5, $6, 1000, 2000)',
      [uid(), h0, 'accepted', 'strict_segment_accepted', 'strict_segment', hex64('input')],
    )
    expect(insert.ok).toBe(true)
    const update = await query('UPDATE "HandoffAssessment" SET decision = $2 WHERE "handoffId" = $1', [h0, 'insufficient'])
    expect(update.ok).toBe(false)
  })

  it('enforces final evidence 1:1 with the handoff and terminal immutability', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const args = evidenceArgs(h0, 0, { previousChunkId: chunkId(fixture, 'runV1', 0), nextChunkId: chunkId(fixture, 'runV1', 1) })
    expect((await insertEvidence(args)).ok).toBe(true)
    const second = await insertEvidence(
      evidenceArgs(h0, 0, { previousChunkId: chunkId(fixture, 'runV1', 0), nextChunkId: chunkId(fixture, 'runV1', 1) }),
    )
    expect(second.ok).toBe(false)
    const update = await query('UPDATE "HandoffEvidence" SET decision = $2 WHERE "handoffId" = $1', [h0, 'insufficient'])
    expect(update.ok).toBe(false)
    expect(update.err).toContain('final and immutable')
  })

  it('rejects deleting final evidence (append-only, no delete-then-reinsert bypass)', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    await insertEvidence(
      evidenceArgs(h0, 0, { previousChunkId: chunkId(fixture, 'runV1', 0), nextChunkId: chunkId(fixture, 'runV1', 1) }),
    )
    const del = await query('DELETE FROM "HandoffEvidence" WHERE "handoffId" = $1', [h0])
    expect(del.ok).toBe(false)
    expect(del.err).toContain('final and immutable')
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM "HandoffEvidence" WHERE "handoffId" = $1', [h0])
    expect(rows[0]!.n).toBe(1)
  })

  it('rejects non-whitelisted accepted evidenceType (no provider_native_word_timing)', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const result = await insertEvidence(
      evidenceArgs(h0, 0, {
        evidenceType: 'provider_native_word_timing',
        previousChunkId: chunkId(fixture, 'runV1', 0),
        nextChunkId: chunkId(fixture, 'runV1', 1),
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.err).toContain('check constraint')
  })

  it('requires full raw identity and anchors for accepted boundary_forced_alignment', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const missingRaw = await insertEvidence(
      evidenceArgs(h0, 0, {
        evidenceType: 'boundary_forced_alignment',
        candidateCount: 1,
        anchorCount: 0,
        previousChunkId: chunkId(fixture, 'runV1', 0),
        nextChunkId: chunkId(fixture, 'runV1', 1),
      }),
    )
    expect(missingRaw.ok).toBe(false)
  })

  it('accepts a fully bound accepted boundary_forced_alignment evidence', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const result = await query(
      `INSERT INTO "HandoffEvidence" ("id", "handoffId", "planRevision", "logicalHandoffIndex", decision, "decisionCode", "evidenceType", "schemaVersion", "pipelineVersion", "previousChunkId", "nextChunkId", "previousAsrObjectKey", "nextAsrObjectKey", "rawObjectKey", "rawVersionId", "rawChecksum", "methodProvider", "methodVersion", "windowStartMs", "windowEndMs", "candidateCount", "anchorCount", "proofKeyVersion", "proofDigest") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [uid(), h0, 0, 0, 'accepted', 'evidence_accepted', 'boundary_forced_alignment', '1', 'g3-transcript-v2',
        chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1),
        'asr://synthetic/left', 'asr://synthetic/right', 'raw://synthetic/object', 'raw-v-1', hex64('raw'),
        'mfa', '3.3.9', 1000, 2000, 1, 2, 'v1', hex64('proof')],
    )
    expect(result.ok).toBe(true)
  })

  it('enforces TranscriptVersion H_* non-negativity, both equalities and hProviderWord=0', async () => {
    const fixture = await createFixture()
    const badProviderWord = await query(
      'INSERT INTO "TranscriptVersion" (id, "mediaAssetId", "processingRunId", version, status, "pipelineVersion", "modelVersion", "durationMs", "hProviderWord") VALUES ($1, $2, $3, 0, $4, $5, $6, 1000, 1)',
      [uid(), fixture.assetId, fixture.runV1, 'BUILDING', 'g3-transcript-v2', 'model-v'],
    )
    expect(badProviderWord.ok).toBe(false)
    expect(badProviderWord.err).toContain('check constraint')

    const badEquality = await query(
      'INSERT INTO "TranscriptVersion" (id, "mediaAssetId", "processingRunId", version, status, "pipelineVersion", "modelVersion", "durationMs", "hTotal", "hUnique", "hR1", "hUnresolved", "hSegment", "hProviderWord", "hAlignment") VALUES ($1, $2, $3, 1, $4, $5, $6, 1000, 2, 2, 0, 1, 0, 0, 0)',
      [uid(), fixture.assetId, fixture.runV1, 'BUILDING', 'g3-transcript-v2', 'model-v'],
    )
    expect(badEquality.ok).toBe(false)

    const badNegative = await query(
      'INSERT INTO "TranscriptVersion" (id, "mediaAssetId", "processingRunId", version, status, "pipelineVersion", "modelVersion", "durationMs", "hUnique") VALUES ($1, $2, $3, 2, $4, $5, $6, 1000, -1)',
      [uid(), fixture.assetId, fixture.runV1, 'BUILDING', 'g3-transcript-v2', 'model-v'],
    )
    expect(badNegative.ok).toBe(false)

    const valid = await query(
      'INSERT INTO "TranscriptVersion" (id, "mediaAssetId", "processingRunId", version, status, "pipelineVersion", "modelVersion", "durationMs", "hTotal", "hUnique", "hR1", "hUnresolved", "hSegment", "hProviderWord", "hAlignment") VALUES ($1, $2, $3, 3, $4, $5, $6, 1000, 2, 1, 0, 1, 0, 0, 1)',
      [uid(), fixture.assetId, fixture.runV1, 'BUILDING', 'g3-transcript-v2', 'model-v'],
    )
    expect(valid.ok).toBe(true)
  })

  it('enforces AlignmentJob idempotency uniqueness, attempt cap and identity immutability', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    const jobColumns = '(id, "handoffId", "idempotencyKey", "correlationHandle", status, attempt, "windowStartMs", "windowEndMs", "methodDigest", "modelDigest", "configDigest", "updatedAt")'
    const job1 = await query(`INSERT INTO "AlignmentJob" ${jobColumns} VALUES ($1,$2,$3,$4,$5,0,1000,2000,$6,$7,$8,now())`, [uid(), h0, 'idem-1', 'corr-1', 'PENDING', hex64('m'), hex64('mo'), hex64('c')])
    expect(job1.ok).toBe(true)
    const dupIdem = await query(`INSERT INTO "AlignmentJob" ${jobColumns} VALUES ($1,$2,$3,$4,$5,0,1000,2000,$6,$7,$8,now())`, [uid(), h0, 'idem-1', 'corr-2', 'PENDING', hex64('m'), hex64('mo'), hex64('c')])
    expect(dupIdem.ok).toBe(false)
    const overAttempts = await query(`INSERT INTO "AlignmentJob" ${jobColumns} VALUES ($1,$2,$3,$4,$5,4,1000,2000,$6,$7,$8,now())`, [uid(), h0, 'idem-3', 'corr-3', 'PENDING', hex64('m'), hex64('mo'), hex64('c')])
    expect(overAttempts.ok).toBe(false)
    const identityUpdate = await query('UPDATE "AlignmentJob" SET "idempotencyKey" = $2 WHERE "handoffId" = $1', [h0, 'idem-changed'])
    expect(identityUpdate.ok).toBe(false)
    const setOnce = await query('UPDATE "AlignmentJob" SET "externalJobId" = $2 WHERE "handoffId" = $1', [h0, 'ext-1'])
    expect(setOnce.ok).toBe(true)
    const overwrite = await query('UPDATE "AlignmentJob" SET "externalJobId" = $2 WHERE "handoffId" = $1', [h0, 'ext-2'])
    expect(overwrite.ok).toBe(false)
  })

  it('rolls back a failed publish transaction without leaving partial evidence', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    await client.query('BEGIN')
    await insertEvidence(
      evidenceArgs(h0, 0, { previousChunkId: chunkId(fixture, 'runV1', 0), nextChunkId: chunkId(fixture, 'runV1', 1) }),
    )
    await client.query('ROLLBACK')
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM "HandoffEvidence" WHERE "handoffId" = $1', [h0])
    expect(rows[0]!.n).toBe(0)
  })

  it('keeps old revisions as immutable history while the current revision participates in publication', async () => {
    const fixture = await createFixture()
    const h0 = uid()
    await insertHandoff(h0, fixture.runV1, 0, 0, chunkId(fixture, 'runV1', 0), chunkId(fixture, 'runV1', 1))
    // Revision 1 needs its own revision-1 chunks; create them to prove coexistence.
    const prev1 = uid()
    const next1 = uid()
    await client.query(
      'INSERT INTO "ProcessingChunk" (id, "processingRunId", "planRevision", "chunkIndex", status, attempt, "idempotencyKey", "modelVersion", "inputObjectKey", "inputVersionId", "inputChecksum", "startMs", "endMs", "updatedAt") VALUES ($1, $2, 1, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11, now())',
      [prev1, fixture.runV1, 0, 'SUCCEEDED', `ik-r1a-${randomBytes(8).toString('hex')}`, 'model-v', `obj://${randomBytes(6).toString('hex')}`, 'v-1', hex64('in-1a'), 0, 1000],
    )
    await client.query(
      'INSERT INTO "ProcessingChunk" (id, "processingRunId", "planRevision", "chunkIndex", status, attempt, "idempotencyKey", "modelVersion", "inputObjectKey", "inputVersionId", "inputChecksum", "startMs", "endMs", "updatedAt") VALUES ($1, $2, 1, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11, now())',
      [next1, fixture.runV1, 1, 'SUCCEEDED', `ik-r1b-${randomBytes(8).toString('hex')}`, 'model-v', `obj://${randomBytes(6).toString('hex')}`, 'v-1', hex64('in-1b'), 1000, 2000],
    )
    expect((await insertHandoff(uid(), fixture.runV1, 1, 0, prev1, next1)).ok).toBe(true)
    const { rows } = await client.query(
      'SELECT "planRevision", "logicalHandoffIndex" FROM "ProcessingHandoff" WHERE "processingRunId" = $1 ORDER BY "planRevision"',
      [fixture.runV1],
    )
    expect(rows).toEqual([
      { planRevision: 0, logicalHandoffIndex: 0 },
      { planRevision: 1, logicalHandoffIndex: 0 },
    ])
  })
})
