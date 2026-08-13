import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerEnv } from '@online-learning/config'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider, type MultipartStorageProvider } from '@online-learning/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MossAdapter } from '../moss/adapter'
import { FakeMossAdapter } from '../moss/fake-adapter'
import { enqueueRecoverableTranscriptRuns } from '../outbox'
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

function wrapStorage(overrides: Partial<MultipartStorageProvider>) {
  return new Proxy(storage, {
    get(target, property) {
      const override = overrides[property as keyof MultipartStorageProvider]
      if (override) return typeof override === 'function' ? override.bind(overrides) : override
      const value = target[property as keyof MinioStorageProvider]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as MultipartStorageProvider
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
    moss.succeed(chunks[0].externalJobId!, { language: 'en', words: [
      { text: 'First.', startMs: 500, endMs: 1_000 }, { text: 'Still.', startMs: 58_000, endMs: 59_000 },
    ] })
    moss.fail(chunks[1].externalJobId!, 'forced_chunk_failure')
    await database.processingChunk.updateMany({ where: { processingRunId: run.id }, data: { nextPollAt: new Date(0) } })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED' })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })).toBe(0)
    expect(await database.privateLesson.count({ where: { mediaAssetId: asset.id } })).toBe(0)

    await database.$transaction([
      database.processingChunk.update({
        where: { id: chunks[1].id },
        data: {
          status: 'QUEUED', externalJobId: null, errorCode: null, failedAt: null,
          externalUpdatedAt: null, externalCancelledAt: null, submittedAt: null,
        },
      }),
      database.processingRun.update({
        where: { id: run.id },
        data: { status: 'QUEUED', errorCode: null, failedAt: null, leaseOwner: null, leaseExpiresAt: null },
      }),
    ])
    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const retried = await database.processingChunk.findUniqueOrThrow({ where: { id: chunks[1].id } })
    expect(retried.externalJobId).toBe(chunks[1].externalJobId)
    expect(moss.submissions).toBe(3)
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: chunks[0].id } })).toMatchObject({ status: 'SUCCEEDED' })
    moss.succeed(retried.externalJobId!, { language: 'en', words: [{ text: 'Recovered.', startMs: 2_500, endMs: 3_500 }] })
    await database.processingChunk.update({ where: { id: retried.id }, data: { nextPollAt: new Date(0) } })
    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })).toBe(1)
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
    await database.mediaObject.updateMany({
      where: { mediaAssetId: asset.id, kind: { in: ['NORMALIZED_AUDIO', 'AUDIO_CHUNK'] } },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    })
    await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 2, failed: 0 })
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

  it('persists and cancels a MOSS job when cancellation commits while submit is in flight', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '5')
    const delegate = new FakeMossAdapter()
    const racingMoss: MossAdapter = {
      submit: async (input) => {
        const submitted = await delegate.submit(input)
        await database.$transaction([
          database.processingRun.update({
            where: { id: run.id },
            data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
          }),
          database.processingChunk.updateMany({
            where: { processingRunId: run.id },
            data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
          }),
        ])
        return submitted
      },
      query: (externalJobId) => delegate.query(externalJobId),
      result: (externalJobId) => delegate.result(externalJobId),
      cancel: (externalJobId) => delegate.cancel(externalJobId),
    }
    const processTranscript = createTranscriptProcessor({ database, storage, moss: racingMoss, env, workerId: 'g3-worker-submit-race' })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    expect(chunk).toMatchObject({ status: 'CANCELLED' })
    expect(chunk.externalJobId).toBeTruthy()
    expect(chunk.externalCancelledAt).not.toBeNull()
    await expect(delegate.query(chunk.externalJobId!)).resolves.toMatchObject({ status: 'cancelled' })
  }, 120_000)

  it('keeps cancellation terminal when a successful MOSS result arrives concurrently', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '11')
    class CancelOnResultMoss extends FakeMossAdapter {
      cancelOnResult = false
      override async result(externalJobId: string) {
        if (this.cancelOnResult) {
          await database.$transaction([
            database.processingRun.update({
              where: { id: run.id },
              data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
            }),
            database.processingChunk.updateMany({
              where: { processingRunId: run.id },
              data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
            }),
          ])
        }
        return super.result(externalJobId)
      }
    }
    const moss = new CancelOnResultMoss()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-complete-cancel-race' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [{ text: 'Too late.', startMs: 500, endMs: 1_500 }] })
    moss.cancelOnResult = true
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ skipped: true, leaseLost: true })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id } })).toBe(0)
    expect(await database.mediaObject.count({ where: { mediaAssetId: asset.id, kind: 'ASR_RAW' } })).toBe(0)
  }, 120_000)

  it('fences a stale result worker, lets a replacement take over, and preserves the chunk model provenance', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '6')
    class LeaseLosingMoss extends FakeMossAdapter {
      loseLease = false
      override async result(externalJobId: string) {
        if (this.loseLease) {
          await database.$transaction([
            database.processingRun.update({
              where: { id: run.id },
              data: { leaseOwner: 'replacement-pending', leaseExpiresAt: new Date(Date.now() + 60_000) },
            }),
            database.processingChunk.updateMany({
              where: { processingRunId: run.id },
              data: { leaseExpiresAt: new Date(0) },
            }),
          ])
        }
        return super.result(externalJobId)
      }
    }
    const moss = new LeaseLosingMoss()
    const firstWorker = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-stale' })
    await firstWorker({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [
      { text: 'Lease', startMs: 500, endMs: 900 }, { text: 'safe.', startMs: 1_000, endMs: 1_500 },
    ] })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })
    moss.loseLease = true

    await expect(firstWorker({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ skipped: true, leaseLost: true })
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).toMatchObject({ status: 'PROCESSING' })
    expect(await database.mediaObject.count({ where: { mediaAssetId: asset.id, kind: 'ASR_RAW' } })).toBe(0)

    moss.loseLease = false
    await database.processingRun.update({
      where: { id: run.id }, data: { leaseOwner: null, leaseExpiresAt: null },
    })
    const replacementEnv = { ...env, MOSS_MODEL_VERSION: 'future-deployment-model' } as ServerEnv
    const replacement = createTranscriptProcessor({ database, storage, moss, env: replacementEnv, workerId: 'g3-worker-replacement' })
    await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    const transcript = await database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })
    expect(transcript.modelVersion).toBe(env.MOSS_MODEL_VERSION)
  }, 120_000)

  it('resumes a database-reserved object after upload response loss without creating a second identity', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '7')
    const moss = new FakeMossAdapter()
    let normalizedUploads = 0
    let loseFirstResponse = true
    const responseLosingStorage = wrapStorage({
      uploadFile: async (objectKey, filePath, contentType) => {
        const uploaded = await storage.uploadFile(objectKey, filePath, contentType)
        if (objectKey.endsWith('/normalized.wav')) {
          normalizedUploads += 1
          if (loseFirstResponse) {
            loseFirstResponse = false
            throw new Error('simulated_upload_response_loss')
          }
        }
        return uploaded
      },
    })
    const firstWorker = createTranscriptProcessor({ database, storage: responseLosingStorage, moss, env, workerId: 'g3-worker-object-gap-a' })
    await expect(firstWorker({ mediaAssetId: asset.id, processingRunId: run.id })).rejects.toThrow('simulated_upload_response_loss')
    const pending = await database.mediaObject.findFirstOrThrow({ where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' } })
    expect(pending).toMatchObject({ versionId: null })
    expect(pending.sizeBytes > 0n).toBe(true)
    expect((pending.metadata as { uploadState?: string }).uploadState).toBe('PENDING')

    const replacement = createTranscriptProcessor({ database, storage: responseLosingStorage, moss, env, workerId: 'g3-worker-object-gap-b' })
    await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const finalized = await database.mediaObject.findMany({ where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' } })
    expect(finalized).toHaveLength(1)
    expect(finalized[0].versionId).not.toBeNull()
    expect((finalized[0].metadata as { uploadState?: string }).uploadState).toBe('READY')
    expect(normalizedUploads).toBe(1)
  }, 120_000)

  it('rejects a corrupted immutable ASR object without publishing any transcript', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '10')
    const moss = new FakeMossAdapter()
    const firstWorker = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-checksum-a' })
    await firstWorker({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [
      { text: 'Checksum', startMs: 500, endMs: 1_000 }, { text: 'guard.', startMs: 1_100, endMs: 1_500 },
    ] })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })
    const corruptingStorage = wrapStorage({
      downloadFile: async (objectKey, filePath, versionId) => {
        await storage.downloadFile(objectKey, filePath, versionId)
        if (objectKey.includes('/asr/')) await writeFile(filePath, 'corrupted-asr')
      },
    })
    const verifier = createTranscriptProcessor({ database, storage: corruptingStorage, moss, env, workerId: 'g3-worker-checksum-b' })

    await expect(verifier({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ failed: true, errorCode: 'transcript_incomplete' })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })).toBe(0)
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ status: 'FAILED', errorCode: 'transcript_incomplete' })
  }, 120_000)

  it('rolls back a failed publish transaction and leaves the previous ACTIVE transcript bound', async () => {
    const { user, asset, run } = await createRun(shortPath, 30_000, '8')
    const legacyRun = await database.processingRun.create({
      data: {
        ownerId: user.id, mediaAssetId: asset.id, pipelineVersion: 'legacy-transcript-v1',
        status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY', completedAt: new Date(),
      },
    })
    const legacy = await database.transcriptVersion.create({
      data: {
        mediaAssetId: asset.id, processingRunId: legacyRun.id, version: 1, status: 'ACTIVE',
        pipelineVersion: 'legacy-transcript-v1', modelVersion: 'legacy-model', durationMs: 30_000,
        cueCount: 1, publishedAt: new Date(),
        cues: { create: { order: 0, startMs: 500, endMs: 1_500, text: 'Previous transcript.', words: [] } },
      },
    })
    await database.privateLesson.create({
      data: {
        ownerId: user.id, mediaAssetId: asset.id, transcriptVersionId: legacy.id,
        title: asset.title, status: 'PROCESSING',
      },
    })
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-publish-rollback' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [
      { text: 'Replacement', startMs: 500, endMs: 1_000 }, { text: 'transcript.', startMs: 1_100, endMs: 1_600 },
    ] })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })
    await database.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION echoflow_test_fail_g3_publish() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'SUCCEEDED' AND NEW."pipelineVersion" = '${G3_PIPELINE_VERSION}' THEN
          RAISE EXCEPTION 'forced publish rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await database.$executeRawUnsafe(`
      CREATE TRIGGER echoflow_test_fail_g3_publish
      BEFORE UPDATE ON "ProcessingRun"
      FOR EACH ROW EXECUTE FUNCTION echoflow_test_fail_g3_publish()
    `)
    try {
      await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).rejects.toThrow()
    } finally {
      await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS echoflow_test_fail_g3_publish ON "ProcessingRun"')
      await database.$executeRawUnsafe('DROP FUNCTION IF EXISTS echoflow_test_fail_g3_publish()')
    }
    expect(await database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } }))
      .toMatchObject({ id: legacy.id, modelVersion: 'legacy-model' })
    expect(await database.privateLesson.findUniqueOrThrow({ where: { mediaAssetId: asset.id } }))
      .toMatchObject({ transcriptVersionId: legacy.id })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id } })).toBe(1)
  }, 120_000)

  it('rebuilds a recoverable transcript queue entry from PostgreSQL after queue loss', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '9')
    await database.processingRun.update({
      where: { id: run.id }, data: { status: 'PROCESSING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(0) },
    })
    const add = vi.fn(async () => undefined)
    await expect(enqueueRecoverableTranscriptRuns(database, { add } as never)).resolves.toEqual({ enqueued: 1 })
    expect(add).toHaveBeenCalledWith('media.transcript_process', {
      mediaAssetId: asset.id, processingRunId: run.id,
    }, expect.objectContaining({ attempts: 1 }))
  }, 120_000)
})
