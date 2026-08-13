import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerEnv } from '@online-learning/config'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeMossAdapter } from '../moss/fake-adapter'
import { G3_PIPELINE_VERSION } from '../transcript/constants'
import { cancelExternalTranscriptJobs, createTranscriptProcessor } from './transcript'
import { cleanupTranscriptObjects } from './transcript-cleanup'

const execFileAsync = promisify(execFile)
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
  MOSS_MAX_ATTEMPTS: 3,
} as ServerEnv
let directory = ''
let shortPath = ''
let longPath = ''

async function generate(path: string, seconds: number) {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart', '-y', path,
  ], { windowsHide: true, timeout: 120_000 })
}

async function createRun(path: string, durationMs: number, suffix: string) {
  const user = await database.user.create({
    data: { phone: `+8613700${suffix.padStart(6, '0')}`, displayName: `Transcript ${suffix}` },
  })
  const key = `g3-worker/${crypto.randomUUID()}.mp4`
  const object = await storage.uploadFile(key, path, 'video/mp4')
  const asset = await database.mediaAsset.create({
    data: {
      ownerId: user.id, title: `Podcast ${suffix}`, originalName: 'podcast.mp4', status: 'PLAYABLE', durationMs,
      objects: { create: {
        kind: 'ORIGINAL', bucket: object.bucket, objectKey: object.objectKey, versionId: object.versionId,
        contentType: 'video/mp4', sizeBytes: BigInt(object.sizeBytes), etag: object.etag,
      } },
    },
  })
  const run = await database.processingRun.create({
    data: { ownerId: user.id, mediaAssetId: asset.id, pipelineVersion: G3_PIPELINE_VERSION, stage: 'PLAYBACK_READY' },
  })
  return { user, asset, run }
}

describe('G3 real media pipeline with deterministic Fake MOSS', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'echoflow-g3-worker-test-'))
    shortPath = join(directory, 'short.mp4')
    longPath = join(directory, 'long.mp4')
    await Promise.all([generate(shortPath, 30), generate(longPath, 80)])
    await storage.ensureBucket()
    await storage.ensureVersioning()
    await database.$connect()
  })

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "MossCallbackReceipt", "ProcessingChunk", "ProcessingRun",
        "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession", "OtpChallenge", "User"
      CASCADE
    `)
  })

  afterAll(async () => {
    await database.$disconnect()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('extracts from zero, persists each stage and atomically publishes one ACTIVE English transcript', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '1')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-success' })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    expect(chunk).toMatchObject({ chunkIndex: 0, startMs: 0, endMs: 30_000, status: 'PROCESSING' })
    expect(chunk.externalJobId).toBeTruthy()
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [
      { text: 'Hello', startMs: 500, endMs: 900 },
      { text: 'podcast.', startMs: 1_000, endMs: 1_600 },
      { text: 'Still', startMs: 28_000, endMs: 28_400 },
      { text: 'here.', startMs: 28_500, endMs: 29_000 },
    ] })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ completed: true, cueCount: 2, wordCount: 4 })
    const [finished, transcript, lesson, objects] = await Promise.all([
      database.processingRun.findUniqueOrThrow({ where: { id: run.id } }),
      database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' }, include: { cues: true } }),
      database.privateLesson.findUniqueOrThrow({ where: { mediaAssetId: asset.id } }),
      database.mediaObject.findMany({ where: { mediaAssetId: asset.id } }),
    ])
    expect(finished).toMatchObject({ status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY' })
    expect(transcript.cues[0]).toMatchObject({ order: 0, startMs: 500, endMs: 1_600, text: 'Hello podcast.' })
    expect(lesson.transcriptVersionId).toBe(transcript.id)
    expect(objects.map((object) => object.kind)).toEqual(expect.arrayContaining(['ORIGINAL', 'NORMALIZED_AUDIO', 'AUDIO_CHUNK', 'ASR_RAW']))
    expect(await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).toEqual({ skipped: true })
  }, 120_000)

  it('keeps the transcript invisible when one required chunk fails', async () => {
    const { asset, run } = await createRun(longPath, 80_000, '2')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-failure' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunks = await database.processingChunk.findMany({ where: { processingRunId: run.id }, orderBy: { chunkIndex: 'asc' } })
    expect(chunks).toHaveLength(2)
    moss.succeed(chunks[0].externalJobId!, { language: 'en', words: [{ text: 'First.', startMs: 500, endMs: 1_000 }] })
    moss.fail(chunks[1].externalJobId!, 'forced_chunk_failure')
    await database.processingChunk.updateMany({ where: { processingRunId: run.id }, data: { nextPollAt: new Date(0) } })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED' })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })).toBe(0)
    expect(await database.privateLesson.count({ where: { mediaAssetId: asset.id } })).toBe(0)
  }, 120_000)

  it('persists cancellation fencing and idempotently cancels the external MOSS job', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '3')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-cancel' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    await database.$transaction([
      database.processingRun.update({ where: { id: run.id }, data: { status: 'CANCELLED', errorCode: 'processing_cancelled' } }),
      database.processingChunk.update({ where: { id: chunk.id }, data: { status: 'CANCELLED', errorCode: 'processing_cancelled' } }),
    ])

    await expect(cancelExternalTranscriptJobs(database, moss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toMatchObject({ cancelled: 1 })
    await expect(moss.query(chunk.externalJobId!)).resolves.toMatchObject({ status: 'cancelled' })
    expect((await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).externalCancelledAt).not.toBeNull()
    await expect(cancelExternalTranscriptJobs(database, moss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toMatchObject({ cancelled: 0 })
    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toEqual({ skipped: true })
  }, 120_000)

  it('cleans successful audio after 24 hours but retains immutable ASR evidence for seven days', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '4')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-cleanup' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [
      { text: 'Starts.', startMs: 500, endMs: 1_000 }, { text: 'Ends.', startMs: 28_000, endMs: 29_000 },
    ] })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    await database.mediaObject.updateMany({
      where: { mediaAssetId: asset.id, kind: { in: ['NORMALIZED_AUDIO', 'AUDIO_CHUNK', 'ASR_RAW'] } },
      data: { createdAt: old },
    })

    await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 2, failed: 0 })
    expect(await database.mediaObject.count({
      where: { mediaAssetId: asset.id, kind: { in: ['NORMALIZED_AUDIO', 'AUDIO_CHUNK'] }, deletedAt: null },
    })).toBe(0)
    expect(await database.mediaObject.count({ where: { mediaAssetId: asset.id, kind: 'ASR_RAW', deletedAt: null } })).toBe(1)
    expect(await database.mediaObject.count({
      where: { mediaAssetId: asset.id, kind: { in: ['NORMALIZED_AUDIO', 'AUDIO_CHUNK'] }, purgedAt: { not: null } },
    })).toBe(2)
  }, 120_000)
})
