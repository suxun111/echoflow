import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerEnv } from '@online-learning/config'
import { G3_PIPELINE_VERSION_V2, PrismaClient } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeMossAdapter } from '../moss/fake-adapter'
import {
  FakeProofDigestService,
  FakeStrictAssessmentInputProvider,
  InMemoryAlignmentAdapter,
} from '../handoff'
import { createTranscriptProcessor } from './transcript'

const execFileAsync = promisify(execFile)
const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex')

const database = new PrismaClient({
  datasources: { db: { url: 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test' } },
})
const storage = new MinioStorageProvider({
  endPoint: 'localhost', port: 9000, useSSL: false,
  accessKey: 'online_learning', secretKey: 'online_learning_secret', bucket: 'echoflow-g3-worker-test',
})
const env = {
  FFMPEG_PATH: 'ffmpeg',
  MOSS_MODEL_VERSION: 'fake-moss-v1',
  MOSS_CHUNK_TARGET_SECONDS: 60,
  MOSS_CHUNK_OVERLAP_SECONDS: 2,
  MOSS_AUDIO_URL_TTL_SECONDS: 900,
  MOSS_CALLBACK_PUBLIC_URL: 'https://api.example/api/v1/integrations/moss/callback',
  MOSS_POLL_INTERVAL_SECONDS: 5,
  MOSS_JOB_TIMEOUT_SECONDS: 6 * 60 * 60,
  MOSS_MAX_ATTEMPTS: 3,
} as ServerEnv

let directory = ''
let shortPath = ''
let twoChunkPath = ''

async function generate(path: string, seconds: number) {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart', '-y', path,
  ], { windowsHide: true, timeout: 120_000 })
}

async function createV2Run(path: string, durationMs: number, suffix: string) {
  const user = await database.user.create({
    data: { phone: `+8613800${suffix.padStart(6, '0')}`, displayName: `V2 ${suffix}` },
  })
  const key = `g3-worker-v2/${randomUUID()}.mp4`
  const object = await storage.uploadFile(key, path, 'video/mp4')
  const asset = await database.mediaAsset.create({
    data: {
      ownerId: user.id, title: `Podcast v2 ${suffix}`, originalName: 'podcast.mp4', status: 'PLAYABLE', durationMs,
      objects: { create: {
        kind: 'ORIGINAL', bucket: object.bucket, objectKey: object.objectKey, versionId: object.versionId,
        contentType: 'video/mp4', sizeBytes: BigInt(object.sizeBytes), etag: object.etag,
      } },
    },
  })
  const run = await database.processingRun.create({
    data: { ownerId: user.id, mediaAssetId: asset.id, pipelineVersion: G3_PIPELINE_VERSION_V2, stage: 'PLAYBACK_READY' },
  })
  return { user, asset, run }
}

function makeProcessor(assessment: FakeStrictAssessmentInputProvider, alignment: InMemoryAlignmentAdapter) {
  const moss = new FakeMossAdapter()
  const processor = createTranscriptProcessor({
    database, storage, moss, env, workerId: `v2-${randomUUID()}`,
    handoff: {
      alignment,
      proof: new FakeProofDigestService(Buffer.from('v2-test-key'), 'test-v1'),
      assessment,
      methodDigest: hex64('mfa-3.3.9'),
      modelDigest: hex64('english_mfa-3.1.0'),
      configDigest: hex64('default'),
    },
  })
  return { processor, moss }
}

const singleChunkWords = { language: 'en' as const, words: [
  { text: 'Hello', startMs: 500, endMs: 900 },
  { text: 'podcast.', startMs: 1_000, endMs: 1_600 },
  { text: 'Still', startMs: 28_000, endMs: 28_400 },
  { text: 'here.', startMs: 28_500, endMs: 29_000 },
] }

const twoChunkWords = {
  language: 'en' as const,
  words: [
    { text: 'First', startMs: 500, endMs: 900 },
    { text: 'part.', startMs: 1_000, endMs: 1_600 },
  ],
}
const twoChunkWordsSecond = {
  language: 'en' as const,
  words: [
    { text: 'Second', startMs: 3_000, endMs: 3_400 },
    { text: 'part.', startMs: 3_500, endMs: 4_000 },
  ],
}

describe('G3 v2 HANDOFF_EVIDENCING with deterministic Fake MOSS + Fake alignment', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'echoflow-g3-v2-test-'))
    shortPath = join(directory, 'short.mp4')
    twoChunkPath = join(directory, 'two.mp4')
    await Promise.all([generate(shortPath, 30), generate(twoChunkPath, 80)])
    await storage.ensureBucket()
    await storage.ensureVersioning()
    await database.$connect()
  })

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "MossCallbackReceipt", "ProcessingChunk", "ProcessingRun",
        "HandoffEvidence", "AlignmentJob", "HandoffAssessment", "ProcessingHandoff",
        "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession", "OtpChallenge", "User"
      CASCADE
    `)
  })

  afterAll(async () => {
    await database.$disconnect()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('single chunk skips handoffs (H_total=0) and publishes a clean ACTIVE transcript', async () => {
    const { asset, run } = await createV2Run(shortPath, 30_000, '11')
    const { processor, moss } = makeProcessor(new FakeStrictAssessmentInputProvider(), new InMemoryAlignmentAdapter())

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, singleChunkWords)
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    const finished = await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })
    const transcript = await database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })
    expect(finished).toMatchObject({ status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY' })
    expect(transcript).toMatchObject({ hTotal: 0, hUnique: 0, hR1: 0, hUnresolved: 0, hSegment: 0, hProviderWord: 0, hAlignment: 0 })
    expect(await database.processingHandoff.count({ where: { processingRunId: run.id } })).toBe(0)
  }, 120_000)

  it('strict-accepted handoff materializes strict_segment evidence and correct H_*', async () => {
    const { asset, run } = await createV2Run(twoChunkPath, 80_000, '12')
    const { processor, moss } = makeProcessor(new FakeStrictAssessmentInputProvider(), new InMemoryAlignmentAdapter())

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunks = await database.processingChunk.findMany({ where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' } })
    expect(chunks).toHaveLength(2)
    moss.succeed(chunks[0].externalJobId!, twoChunkWords)
    moss.succeed(chunks[1].externalJobId!, twoChunkWordsSecond)
    await database.processingChunk.updateMany({ where: { processingRunId: run.id }, data: { nextPollAt: new Date(0) } })

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    const transcript = await database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })
    expect(transcript).toMatchObject({ hTotal: 1, hUnique: 1, hR1: 0, hUnresolved: 0, hSegment: 1, hProviderWord: 0, hAlignment: 0 })
    const evidence = await database.handoffEvidence.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(evidence).toMatchObject({ decision: 'accepted', evidenceType: 'strict_segment', candidateCount: 1 })
  }, 120_000)

  it('strict-insufficient handoff routes to the alignment Fake and materializes boundary_forced_alignment', async () => {
    const { asset, run } = await createV2Run(twoChunkPath, 80_000, '13')
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'insufficient', decisionCode: 'no_handoff_text' })
    const alignment = new InMemoryAlignmentAdapter()
    const { processor, moss } = makeProcessor(assessment, alignment)

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunks = await database.processingChunk.findMany({ where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' } })
    moss.succeed(chunks[0].externalJobId!, twoChunkWords)
    moss.succeed(chunks[1].externalJobId!, twoChunkWordsSecond)
    await database.processingChunk.updateMany({ where: { processingRunId: run.id }, data: { nextPollAt: new Date(0) } })

    // strict insufficient -> alignment submit -> waiting for the (fake) job.
    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const job = await database.alignmentJob.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(job.externalJobId).toBeTruthy()
    alignment.scriptOutcome(job.externalJobId!, {
      state: 'SUCCEEDED',
      result: { decision: 'accepted', decisionCode: 'evidence_accepted', candidateCount: 1, anchorCount: 2, coverageMs: 200 },
    })

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    const transcript = await database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })
    expect(transcript).toMatchObject({ hTotal: 1, hUnique: 1, hR1: 0, hUnresolved: 0, hSegment: 0, hProviderWord: 0, hAlignment: 1 })
    const evidence = await database.handoffEvidence.findFirstOrThrow({ where: { handoff: { processingRunId: run.id } } })
    expect(evidence).toMatchObject({ decision: 'accepted', evidenceType: 'boundary_forced_alignment', anchorCount: 2 })
  }, 120_000)

  it('ambiguous handoff fails closed without publishing a transcript', async () => {
    const { asset, run } = await createV2Run(twoChunkPath, 80_000, '14')
    const assessment = new FakeStrictAssessmentInputProvider()
    assessment.script(0, { kind: 'ambiguous', decisionCode: 'multiple_valid_alignments' })
    const { processor, moss } = makeProcessor(assessment, new InMemoryAlignmentAdapter())

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunks = await database.processingChunk.findMany({ where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' } })
    moss.succeed(chunks[0].externalJobId!, twoChunkWords)
    moss.succeed(chunks[1].externalJobId!, twoChunkWordsSecond)
    await database.processingChunk.updateMany({ where: { processingRunId: run.id }, data: { nextPollAt: new Date(0) } })

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ failed: true, errorCode: 'transcript_incomplete' })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'transcript_incomplete' })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id } })).toBe(0)
  }, 120_000)
})
