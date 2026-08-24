import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerEnv } from '@online-learning/config'
import { MAX_UPLOAD_DURATION_MS } from '@online-learning/contracts'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider, type MultipartStorageProvider } from '@online-learning/storage'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MossAdapter } from '../moss/adapter'
import { FakeMossAdapter } from '../moss/fake-adapter'
import { enqueuePendingTranscriptCancellations, enqueueRecoverableTranscriptRuns } from '../outbox'
import { G3_PIPELINE_VERSION } from '../transcript/constants'
import { cancelExternalTranscriptJobs, createTranscriptProcessor, normalizedWavDurationMs, renewTranscriptRunLease } from './transcript'
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
  MOSS_JOB_TIMEOUT_SECONDS: 6 * 60 * 60,
  MOSS_MAX_ATTEMPTS: 3,
} as ServerEnv
let directory = ''
let shortPath = ''
let longPath = ''
let repairPath = ''

async function generate(path: string, seconds: number, audioFilter?: string) {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    ...(audioFilter ? ['-af', audioFilter] : []),
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart', '-y', path,
  ], { windowsHide: true, timeout: 120_000 })
}

async function createRun(path: string, durationMs: number | null, suffix: string) {
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
    repairPath = join(directory, 'repair.mp4')
    await Promise.all([
      generate(shortPath, 30),
      generate(longPath, 80),
      generate(repairPath, 140, "volume=0:enable='between(t,48,51)+between(t,59,61)+between(t,119,121)'"),
    ])
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

  function overlapSegment(
    chunk: { startMs: number; endMs: number },
    peer: { startMs: number; endMs: number },
    text: string,
  ) {
    const startMs = Math.max(chunk.startMs, peer.startMs) + 200
    const endMs = Math.min(chunk.endMs, peer.endMs) - 200
    if (endMs <= startMs) throw new Error('test_chunks_do_not_overlap')
    return { text, startMs: startMs - chunk.startMs, endMs: endMs - chunk.startMs }
  }

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

  it('fails closed before audio extraction for a legacy playable asset above the sixty-minute V1 limit', async () => {
    const { asset, run } = await createRun(shortPath, MAX_UPLOAD_DURATION_MS + 1, '60')
    const download = vi.spyOn(storage, 'downloadFile')
    const processTranscript = createTranscriptProcessor({
      database, storage, moss: new FakeMossAdapter(), env, workerId: 'g3-worker-duration-limit',
    })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ failed: true, errorCode: 'media_duration_unsupported' })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ status: 'FAILED', errorCode: 'media_duration_unsupported' })
    expect(await database.processingChunk.count({ where: { processingRunId: run.id } })).toBe(0)
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id } })).toBe(0)
    expect(download).not.toHaveBeenCalled()
    download.mockRestore()
  })

  it('fails closed before audio extraction when a legacy playable asset has no measured duration', async () => {
    const { asset, run } = await createRun(shortPath, null, '61')
    const download = vi.spyOn(storage, 'downloadFile')
    const processTranscript = createTranscriptProcessor({
      database, storage, moss: new FakeMossAdapter(), env, workerId: 'g3-worker-duration-unknown',
    })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ failed: true, errorCode: 'media_duration_unsupported' })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ status: 'FAILED', errorCode: 'media_duration_unsupported' })
    expect(await database.processingChunk.count({ where: { processingRunId: run.id } })).toBe(0)
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id } })).toBe(0)
    expect(download).not.toHaveBeenCalled()
    download.mockRestore()
  })

  it('caps each MOSS audio range to the measured normalized WAV duration when container metadata is slightly longer', async () => {
    const { asset, run } = await createRun(longPath, 80_123, '28')
    const processTranscript = createTranscriptProcessor({
      database, storage, moss: new FakeMossAdapter(), env, workerId: 'g3-worker-audio-duration-cap',
    })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const chunks = await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' },
    })
    expect(chunks).toHaveLength(2)
    const normalized = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO', deletedAt: null },
    })
    const normalizedPath = join(directory, `${run.id}-normalized.wav`)
    await storage.downloadFile(normalized.objectKey, normalizedPath, normalized.versionId)
    const normalizedDurationMs = normalizedWavDurationMs(await readFile(normalizedPath))
    expect(normalizedDurationMs).toBeGreaterThan(60_000)
    expect(normalizedDurationMs).toBeLessThan(80_123)
    expect((normalized.metadata as { normalizedAudioDurationMs?: number }).normalizedAudioDurationMs).toBe(normalizedDurationMs)

    const last = chunks.at(-1)!
    expect(last.endMs).toBeLessThanOrEqual(normalizedDurationMs)
    const lastPath = join(directory, `${run.id}-last-chunk.wav`)
    await storage.downloadFile(last.inputObjectKey, lastPath, last.inputVersionId)
    expect(Math.abs(normalizedWavDurationMs(await readFile(lastPath)) - (last.endMs - last.startMs))).toBeLessThanOrEqual(50)
  }, 120_000)

  it('replans only an ambiguous adjacent pair as an immutable revision overlay before publishing', async () => {
    const { asset, run } = await createRun(repairPath, 140_000, '101')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-replan' })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const revisionZero = await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' },
    })
    expect(revisionZero).toHaveLength(3)
    const immutableIdentity = revisionZero.map((chunk) => ({
      id: chunk.id, planRevision: chunk.planRevision, chunkIndex: chunk.chunkIndex,
      startMs: chunk.startMs, endMs: chunk.endMs, inputObjectKey: chunk.inputObjectKey,
      inputVersionId: chunk.inputVersionId, inputChecksum: chunk.inputChecksum,
      idempotencyKey: chunk.idempotencyKey, externalJobId: chunk.externalJobId, modelVersion: chunk.modelVersion,
    }))
    const untouchedThird = revisionZero[2]
    await expect(database.processingChunk.update({
      where: { id: revisionZero[0].id }, data: { startMs: revisionZero[0].startMs + 1 },
    })).rejects.toThrow('immutable identity')

    moss.succeed(revisionZero[0].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionZero[0], revisionZero[1], 'Old boundary.'),
    ] })
    moss.succeed(revisionZero[1].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionZero[1], revisionZero[0], 'Different boundary.'),
      overlapSegment(revisionZero[1], revisionZero[2], 'Bridge.'),
    ] })
    moss.succeed(revisionZero[2].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionZero[2], revisionZero[1], 'Bridge.'),
    ] })
    await database.processingChunk.updateMany({
      where: { processingRunId: run.id, planRevision: 0 }, data: { nextPollAt: new Date(0) },
    })

    const repairProcessor = createTranscriptProcessor({
      database, storage, moss, env: { ...env, MOSS_MODEL_VERSION: 'fake-moss-v2' } as ServerEnv,
      workerId: 'g3-worker-replan-after-deploy',
    })
    await expect(repairProcessor({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ waiting: true, replanned: true })
    const [repairing, preservedRevisionZero, revisionOne, preservedAsr] = await Promise.all([
      database.processingRun.findUniqueOrThrow({ where: { id: run.id } }),
      database.processingChunk.findMany({ where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' } }),
      database.processingChunk.findMany({ where: { processingRunId: run.id, planRevision: 1 }, orderBy: { chunkIndex: 'asc' } }),
      database.mediaObject.findMany({
        where: { mediaAssetId: asset.id, kind: 'ASR_RAW', deletedAt: null, metadata: { path: ['planRevision'], equals: 0 } },
        orderBy: { objectKey: 'asc' }, select: { objectKey: true, versionId: true, checksumSha256: true },
      }),
    ])
    expect(repairing).toMatchObject({ activePlanRevision: 0, pendingPlanRevision: 1, status: 'PROCESSING', stage: 'TRANSCRIBING' })
    expect(preservedRevisionZero.map((chunk) => ({
      id: chunk.id, planRevision: chunk.planRevision, chunkIndex: chunk.chunkIndex,
      startMs: chunk.startMs, endMs: chunk.endMs, inputObjectKey: chunk.inputObjectKey,
      inputVersionId: chunk.inputVersionId, inputChecksum: chunk.inputChecksum,
      idempotencyKey: chunk.idempotencyKey, externalJobId: chunk.externalJobId, modelVersion: chunk.modelVersion,
    }))).toEqual(immutableIdentity)
    expect(revisionOne.map((chunk) => chunk.chunkIndex)).toEqual([0, 1])
    expect(revisionOne).toHaveLength(2)
    expect(revisionOne.map((chunk) => chunk.modelVersion)).toEqual([env.MOSS_MODEL_VERSION, env.MOSS_MODEL_VERSION])
    expect(revisionOne[0].endMs).not.toBe(revisionZero[0].endMs)
    expect(revisionOne[1].startMs).not.toBe(revisionZero[1].startMs)
    expect((repairing.repairPlan as { originalBoundaryMs?: number; replacementBoundaryMs?: number } | null)?.originalBoundaryMs)
      .not.toBe((repairing.repairPlan as { originalBoundaryMs?: number; replacementBoundaryMs?: number } | null)?.replacementBoundaryMs)
    const immutableResults = preservedRevisionZero.map((chunk) => ({
      id: chunk.id, externalJobId: chunk.externalJobId, resultObjectKey: chunk.resultObjectKey,
      resultVersionId: chunk.resultVersionId, resultChecksum: chunk.resultChecksum,
    }))
    expect(preservedAsr).toHaveLength(3)
    await expect(database.processingChunk.update({
      where: { id: preservedRevisionZero[0].id }, data: { resultChecksum: 'f'.repeat(64) },
    })).rejects.toThrow('immutable identity')
    for (const replacement of revisionOne) {
      const prior = revisionZero.find((chunk) => chunk.chunkIndex === replacement.chunkIndex)!
      expect(replacement.inputVersionId).toBeTruthy()
      expect(replacement.inputChecksum).toMatch(/^[a-f0-9]{64}$/)
      expect(replacement.inputObjectKey).not.toBe(prior.inputObjectKey)
      expect(replacement.idempotencyKey).not.toBe(prior.idempotencyKey)
    }

    await expect(repairProcessor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    const submittedRevisionOne = await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 1 }, orderBy: { chunkIndex: 'asc' },
    })
    expect(moss.submissions).toBe(5)
    expect((await database.processingChunk.findUniqueOrThrow({ where: { id: untouchedThird.id } }))).toMatchObject({
      id: untouchedThird.id, idempotencyKey: untouchedThird.idempotencyKey,
      externalJobId: untouchedThird.externalJobId,
    })

    moss.succeed(submittedRevisionOne[0].externalJobId!, { language: 'en', segments: [
      overlapSegment(submittedRevisionOne[0], submittedRevisionOne[1], 'Handoff.'),
    ] })
    moss.succeed(submittedRevisionOne[1].externalJobId!, { language: 'en', segments: [
      overlapSegment(submittedRevisionOne[1], submittedRevisionOne[0], 'Handoff.'),
      overlapSegment(submittedRevisionOne[1], revisionZero[2], 'Bridge.'),
    ] })
    await database.processingChunk.updateMany({
      where: { processingRunId: run.id, planRevision: 1 }, data: { nextPollAt: new Date(0) },
    })
    await expect(repairProcessor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ activePlanRevision: 1, pendingPlanRevision: null, status: 'SUCCEEDED' })
    expect(await database.transcriptVersion.findFirstOrThrow({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } }))
      .toMatchObject({ planRevision: 1 })
    expect((await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' },
    })).map((chunk) => ({
      id: chunk.id, externalJobId: chunk.externalJobId, resultObjectKey: chunk.resultObjectKey,
      resultVersionId: chunk.resultVersionId, resultChecksum: chunk.resultChecksum,
    }))).toEqual(immutableResults)
    expect(await database.mediaObject.findMany({
      where: { mediaAssetId: asset.id, kind: 'ASR_RAW', deletedAt: null, metadata: { path: ['planRevision'], equals: 0 } },
      orderBy: { objectKey: 'asc' }, select: { objectKey: true, versionId: true, checksumSha256: true },
    })).toEqual(preservedAsr)
  }, 240_000)

  it('fails closed after the one allowed repair still has an ambiguous handoff', async () => {
    const { asset, run } = await createRun(repairPath, 140_000, '102')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-replan-limit' })

    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const revisionZero = await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' },
    })
    moss.succeed(revisionZero[0].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionZero[0], revisionZero[1], 'First mismatch.'),
    ] })
    moss.succeed(revisionZero[1].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionZero[1], revisionZero[0], 'Second mismatch.'),
      overlapSegment(revisionZero[1], revisionZero[2], 'Bridge.'),
    ] })
    moss.succeed(revisionZero[2].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionZero[2], revisionZero[1], 'Bridge.'),
    ] })
    await database.processingChunk.updateMany({
      where: { processingRunId: run.id, planRevision: 0 }, data: { nextPollAt: new Date(0) },
    })
    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ waiting: true, replanned: true })
    const immutableRevisionZero = (await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' },
      select: {
        id: true, chunkIndex: true, inputObjectKey: true, inputVersionId: true, inputChecksum: true,
        externalJobId: true, resultObjectKey: true, resultVersionId: true, resultChecksum: true,
      },
    })).map((chunk) => ({ ...chunk }))

    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const revisionOne = await database.processingChunk.findMany({
      where: { processingRunId: run.id, planRevision: 1 }, orderBy: { chunkIndex: 'asc' },
    })
    moss.succeed(revisionOne[0].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionOne[0], revisionOne[1], 'Still first mismatch.'),
    ] })
    moss.succeed(revisionOne[1].externalJobId!, { language: 'en', segments: [
      overlapSegment(revisionOne[1], revisionOne[0], 'Still second mismatch.'),
    ] })
    await database.processingChunk.updateMany({
      where: { processingRunId: run.id, planRevision: 1 }, data: { nextPollAt: new Date(0) },
    })

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ failed: true, errorCode: 'transcript_incomplete' })
    const [failedRun, failedAsset, finalRevisionZero, finalRevisionOne] = await Promise.all([
      database.processingRun.findUniqueOrThrow({ where: { id: run.id } }),
      database.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
      database.processingChunk.findMany({
        where: { processingRunId: run.id, planRevision: 0 }, orderBy: { chunkIndex: 'asc' },
        select: {
          id: true, chunkIndex: true, inputObjectKey: true, inputVersionId: true, inputChecksum: true,
          externalJobId: true, resultObjectKey: true, resultVersionId: true, resultChecksum: true,
        },
      }),
      database.processingChunk.findMany({
        where: { processingRunId: run.id, planRevision: 1 }, orderBy: { chunkIndex: 'asc' },
      }),
    ])
    expect(failedRun).toMatchObject({
      status: 'FAILED', stage: 'MERGING', errorCode: 'transcript_incomplete', activePlanRevision: 0, pendingPlanRevision: 1,
      completedAt: null, leaseOwner: null, leaseExpiresAt: null,
    })
    expect(failedRun.failedAt).toBeInstanceOf(Date)
    const errorDetail = failedRun.errorDetail as {
      g3MergeFailureDiagnostic: { handoff: Record<string, unknown>; repair: Record<string, unknown> }
    }
    const diagnostic = errorDetail.g3MergeFailureDiagnostic
    expect(Object.keys(errorDetail).sort()).toEqual(['g3MergeFailureDiagnostic'])
    expect(Object.keys(diagnostic).sort()).toEqual([
      'errorCode', 'evaluatedPlanRevision', 'handoff', 'repair', 'schemaVersion', 'source',
    ])
    expect(Object.keys(diagnostic.handoff).sort()).toEqual([
      'failureClass', 'kind', 'maximumCandidateTokenCount', 'nextBoundarySegmentCount', 'nextBoundaryTokenCount',
      'nextChunkIndex', 'overlapDurationMs', 'overlapEndMs', 'overlapStartMs', 'previousBoundarySegmentCount',
      'previousBoundaryTokenCount', 'previousChunkIndex', 'speakerCompatibleCandidateCount',
      'textOnlyCandidateCount', 'timeCompatibleCandidateCount',
    ])
    expect(Object.keys(diagnostic.repair).sort()).toEqual([
      'activePlanRevision', 'decision', 'maximumAutomaticRevisions', 'pendingPlanRevision',
    ])
    expect(diagnostic).toMatchObject({
      schemaVersion: 1,
      source: 'strict_segment_merge',
      errorCode: 'transcript_incomplete',
      evaluatedPlanRevision: 1,
      handoff: {
        kind: 'ambiguous_segment_handoff', previousChunkIndex: 0, nextChunkIndex: 1,
        textOnlyCandidateCount: 0, timeCompatibleCandidateCount: 0, speakerCompatibleCandidateCount: 0,
        maximumCandidateTokenCount: 0, failureClass: 'no_textual_suffix_prefix',
      },
      repair: {
        maximumAutomaticRevisions: 1,
        activePlanRevision: 0,
        pendingPlanRevision: 1,
        decision: 'blocked_pending_revision',
      },
    })
    expect(JSON.stringify(failedRun.errorDetail)).not.toContain('Still first mismatch.')
    expect(JSON.stringify(failedRun.errorDetail)).not.toContain('Still second mismatch.')
    expect(finalRevisionZero).toEqual(immutableRevisionZero)
    expect(finalRevisionOne).toHaveLength(2)
    expect(finalRevisionOne.every((chunk) => chunk.status === 'SUCCEEDED')).toBe(true)
    expect(await database.processingChunk.count({ where: { processingRunId: run.id, planRevision: 2 } })).toBe(0)
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id } })).toBe(0)
    expect(await database.subtitleCue.count()).toBe(0)
    expect(await database.privateLesson.count({ where: { mediaAssetId: asset.id } })).toBe(0)
    expect(failedAsset.status).toBe('PLAYABLE')
  }, 240_000)

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

  it('cancels and schedules only the effective overlay pair, never its historical predecessor', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '103')
    const moss = new FakeMossAdapter()
    const legacy = await moss.submit({
      idempotencyKey: `g3:legacy-${run.id}`, audioUrl: 'https://example.invalid/legacy.wav', callbackUrl: env.MOSS_CALLBACK_PUBLIC_URL!,
      language: 'en', modelVersion: env.MOSS_MODEL_VERSION, chunkIndex: 0, startMs: 0, endMs: 30_000,
    })
    const replacement = await moss.submit({
      idempotencyKey: `g3:replacement-${run.id}`, audioUrl: 'https://example.invalid/replacement.wav', callbackUrl: env.MOSS_CALLBACK_PUBLIC_URL!,
      language: 'en', modelVersion: env.MOSS_MODEL_VERSION, chunkIndex: 0, startMs: 0, endMs: 29_500,
    })
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id }, data: { status: 'CANCELLED', pendingPlanRevision: 1, errorCode: 'processing_cancelled' },
      }),
      database.processingChunk.create({
        data: {
          processingRunId: run.id, planRevision: 0, chunkIndex: 0, startMs: 0, endMs: 30_000,
          status: 'SUCCEEDED', idempotencyKey: legacy.idempotencyKey, externalJobId: legacy.externalJobId,
          modelVersion: env.MOSS_MODEL_VERSION, inputObjectKey: `test/${run.id}/legacy.wav`,
        },
      }),
      database.processingChunk.create({
        data: {
          processingRunId: run.id, planRevision: 1, chunkIndex: 0, startMs: 0, endMs: 29_500,
          status: 'CANCELLED', errorCode: 'processing_cancelled', idempotencyKey: replacement.idempotencyKey,
          externalJobId: replacement.externalJobId, modelVersion: env.MOSS_MODEL_VERSION,
          inputObjectKey: `test/${run.id}/replacement.wav`, inputVersionId: 'replacement-input-v1', inputChecksum: 'd'.repeat(64),
        },
      }),
    ])
    const add = vi.fn(async () => undefined)
    await expect(enqueuePendingTranscriptCancellations(database, { add } as never)).resolves.toEqual({ enqueued: 1 })
    expect(add).toHaveBeenCalledTimes(1)
    await expect(cancelExternalTranscriptJobs(database, moss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toEqual({ skipped: false, cancelled: 1 })
    await expect(moss.query(replacement.externalJobId)).resolves.toMatchObject({ status: 'cancelled' })
    await expect(moss.query(legacy.externalJobId)).resolves.toMatchObject({ status: 'queued' })
    await expect(enqueuePendingTranscriptCancellations(database, { add } as never)).resolves.toEqual({ enqueued: 0 })
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

  it('serializes terminal cleanup with retry adoption and keeps the retried object alive', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '23')
    const moss = new FakeMossAdapter()
    const seed = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-cleanup-seed' })
    await seed({ mediaAssetId: asset.id, processingRunId: run.id })
    const normalized = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' },
    })
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id }, data: {
          status: 'FAILED', stage: 'PLAYBACK_READY', errorCode: 'audio_extract_failed',
          leaseOwner: null, leaseExpiresAt: null,
        },
      }),
      database.processingChunk.deleteMany({ where: { processingRunId: run.id } }),
      database.mediaObject.update({
        where: { id: normalized.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
      }),
    ])
    let releaseCleanup!: () => void
    let signalCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanup = resolve })
    const cleanupStorage = wrapStorage({
      remove: async (objectKey, versionId) => {
        if (objectKey === normalized.objectKey) {
          signalCleanup()
          await cleanupGate
        }
        return storage.remove(objectKey, versionId)
      },
    })
    const cleanup = cleanupTranscriptObjects(database, cleanupStorage)
    await cleanupStarted
    expect(await database.mediaObject.findUniqueOrThrow({ where: { id: normalized.id } })).toMatchObject({
      deletedAt: expect.any(Date), purgedAt: null,
    })
    await database.processingRun.update({
      where: { id: run.id }, data: { status: 'QUEUED', stage: 'PLAYBACK_READY', errorCode: null, leaseOwner: null, leaseExpiresAt: null },
    })
    const replacement = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-cleanup-retry' })
    const retrying = replacement({ mediaAssetId: asset.id, processingRunId: run.id })
    releaseCleanup()
    await expect(cleanup).resolves.toMatchObject({ cleaned: 1, failed: 0 })
    await expect(retrying).resolves.toMatchObject({ waiting: true })
    const retired = await database.mediaObject.findUniqueOrThrow({ where: { id: normalized.id } })
    expect(retired.deletedAt).not.toBeNull()
    expect(retired.purgedAt).not.toBeNull()
    const adopted = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO', deletedAt: null },
    })
    expect(adopted).toMatchObject({ deletedAt: null, purgedAt: null })
    expect((adopted.metadata as { uploadState?: string }).uploadState).toBe('READY')
    expect(adopted.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    await expect(storage.statObject(adopted.objectKey, adopted.versionId)).resolves.toMatchObject({ objectKey: adopted.objectKey })
  }, 120_000)

  it('does not resurrect an expired run lease during a delayed heartbeat', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '24')
    const expired = new Date(Date.now() - 1_000)
    await database.processingRun.update({
      where: { id: run.id }, data: { status: 'PROCESSING', leaseOwner: 'g3-expired-owner', leaseExpiresAt: expired },
    })
    await expect(renewTranscriptRunLease(database, {
      mediaAssetId: asset.id, processingRunId: run.id,
    }, 'g3-expired-owner')).resolves.toEqual({ count: 0 })
    expect((await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).leaseExpiresAt).toEqual(expired)
  })

  it('recovers storage initialization after a transient versioning failure without restarting the processor', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '28')
    let ensureVersioningCalls = 0
    const transientStorage = wrapStorage({
      ensureVersioning: async () => {
        ensureVersioningCalls += 1
        if (ensureVersioningCalls === 1) throw new Error('transient_versioning_failure')
        return storage.ensureVersioning()
      },
    })
    const processor = createTranscriptProcessor({
      database, storage: transientStorage, moss: new FakeMossAdapter(), env, workerId: 'g3-storage-recovery',
    })
    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).rejects.toThrow('transient_versioning_failure')
    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
    expect(ensureVersioningCalls).toBe(2)
  }, 120_000)

  it('persists and cancels a MOSS job when cancellation commits while submit is in flight', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '5')
    const delegate = new FakeMossAdapter()
    const racingMoss: MossAdapter = {
      findByIdempotencyKey: (idempotencyKey) => delegate.findByIdempotencyKey(idempotencyKey),
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

    await expect(processTranscript({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ skipped: true, leaseLost: true })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    expect(chunk).toMatchObject({ status: 'CANCELLED' })
    expect(chunk.externalJobId).toBeTruthy()
    expect(chunk.externalCancelledAt).not.toBeNull()
    await expect(delegate.query(chunk.externalJobId!)).resolves.toMatchObject({ status: 'cancelled' })
  }, 120_000)

  it('recovers an accepted MOSS job by idempotency after response loss, then cancels it', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '12')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-cancel-recovery' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    const externalJobId = chunk.externalJobId!
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id },
        data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
      }),
      database.processingChunk.update({
        where: { id: chunk.id },
        data: {
          status: 'CANCELLED', errorCode: 'processing_cancelled', externalJobId: null,
          externalCancelledAt: null, leaseOwner: null, leaseExpiresAt: null,
        },
      }),
    ])

    await expect(cancelExternalTranscriptJobs(database, moss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toMatchObject({ cancelled: 1 })
    const recovered = await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })
    expect(recovered).toMatchObject({ externalJobId })
    expect(recovered.externalCancelledAt).not.toBeNull()
    await expect(moss.query(externalJobId)).resolves.toMatchObject({ status: 'cancelled' })
  }, 120_000)

  it('keeps a negative cancellation lookup recoverable until the provider can expose the accepted job', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '15')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-cancel-negative' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id }, data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
      }),
      database.processingChunk.update({
        where: { id: chunk.id },
        data: { status: 'CANCELLED', errorCode: 'processing_cancelled', externalJobId: null, externalCancelledAt: null },
      }),
    ])
    const originalExternalJobId = chunk.externalJobId!
    // A provider read replica can briefly return "not found" after accepting the submit.
    const lookupLagMoss: MossAdapter = {
      findByIdempotencyKey: async () => null,
      submit: (input) => moss.submit(input), query: (id) => moss.query(id),
      result: (id) => moss.result(id), cancel: (id) => moss.cancel(id),
    }
    await expect(cancelExternalTranscriptJobs(database, lookupLagMoss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toEqual({ skipped: false, cancelled: 0 })
    expect((await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).externalCancelledAt).toBeNull()

    await expect(cancelExternalTranscriptJobs(database, moss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toMatchObject({ cancelled: 1 })
    expect(await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } }))
      .toMatchObject({ externalJobId: originalExternalJobId })
    await expect(moss.query(originalExternalJobId)).resolves.toMatchObject({ status: 'cancelled' })
  }, 120_000)

  it('does not falsely confirm a timeout cancellation when the provider cancel call fails', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '16')
    const moss = new FakeMossAdapter()
    const processTranscript = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-worker-timeout-cancel' })
    await processTranscript({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id }, data: { status: 'FAILED', errorCode: 'moss_timeout', leaseOwner: null, leaseExpiresAt: null },
      }),
      database.processingChunk.update({
        where: { id: chunk.id },
        data: { status: 'FAILED', errorCode: 'moss_timeout', externalCancelledAt: null, leaseOwner: null, leaseExpiresAt: null },
      }),
    ])
    let failCancel = true
    const flakyCancelMoss: MossAdapter = {
      findByIdempotencyKey: (key) => moss.findByIdempotencyKey(key),
      submit: (input) => moss.submit(input), query: (id) => moss.query(id), result: (id) => moss.result(id),
      cancel: async (id) => {
        if (failCancel) throw new Error('simulated_cancel_timeout')
        await moss.cancel(id)
      },
    }
    await expect(cancelExternalTranscriptJobs(database, flakyCancelMoss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).rejects.toThrow('simulated_cancel_timeout')
    expect((await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).externalCancelledAt).toBeNull()
    const add = vi.fn(async () => undefined)
    await expect(enqueuePendingTranscriptCancellations(database, { add } as never)).resolves.toEqual({ enqueued: 1 })
    failCancel = false
    await expect(cancelExternalTranscriptJobs(database, flakyCancelMoss, {
      mediaAssetId: asset.id, processingRunId: run.id,
    })).resolves.toMatchObject({ cancelled: 1 })
    expect((await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })).externalCancelledAt).not.toBeNull()
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

  it('prevents a stale run generation from releasing or failing a claimed MOSS chunk', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '30')
    class RunTakeoverOnQueryMoss extends FakeMossAdapter {
      takeover = false
      override async query(externalJobId: string) {
        if (this.takeover) {
          await database.processingRun.update({
            where: { id: run.id },
            data: { leaseOwner: 'g3-new-generation', leaseExpiresAt: new Date(Date.now() + 60_000) },
          })
        }
        return super.query(externalJobId)
      }
    }
    const moss = new RunTakeoverOnQueryMoss()
    const processor = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-chunk-generation' })
    await processor({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })
    moss.takeover = true

    await expect(processor({ mediaAssetId: asset.id, processingRunId: run.id }))
      .resolves.toMatchObject({ skipped: true, leaseLost: true })
    const fenced = await database.processingChunk.findUniqueOrThrow({ where: { id: chunk.id } })
    expect(fenced.status).toBe('PROCESSING')
    expect(fenced.nextPollAt).toEqual(new Date(0))
    expect(fenced.leaseOwner).toMatch(/^g3-chunk-generation:/)
    expect((await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).leaseOwner).toBe('g3-new-generation')
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

  it('prevents a stale publisher from committing after a replacement takes over the run lease', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '20')
    const moss = new FakeMossAdapter()
    const seed = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-publish-seed' })
    await seed({ mediaAssetId: asset.id, processingRunId: run.id })
    const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
    moss.succeed(chunk.externalJobId!, { language: 'en', words: [
      { text: 'Publish', startMs: 500, endMs: 1_000 }, { text: 'once.', startMs: 1_100, endMs: 1_600 },
    ] })
    await database.processingChunk.update({ where: { id: chunk.id }, data: { nextPollAt: new Date(0) } })
    let releaseMergeRead!: () => void
    let signalMergeRead!: () => void
    const mergeReadGate = new Promise<void>((resolve) => { releaseMergeRead = resolve })
    const mergeReadStarted = new Promise<void>((resolve) => { signalMergeRead = resolve })
    const pausedStorage = wrapStorage({
      downloadFile: async (objectKey, filePath, versionId) => {
        await storage.downloadFile(objectKey, filePath, versionId)
        if (objectKey.includes('/asr/')) {
          signalMergeRead()
          await mergeReadGate
        }
      },
    })
    const stale = createTranscriptProcessor({ database, storage: pausedStorage, moss, env, workerId: 'g3-publisher-stale' })
    const stalePublishing = stale({ mediaAssetId: asset.id, processingRunId: run.id })
    await mergeReadStarted
    await database.processingRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } })
    const replacement = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-publisher-replacement' })
    await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
    releaseMergeRead()
    await expect(stalePublishing).resolves.toMatchObject({ skipped: true, leaseLost: true })
    expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })).toBe(1)
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject({ status: 'SUCCEEDED', stage: 'TRANSCRIPT_READY' })
  }, 120_000)

  it.each(['CUE_SEGMENTING', 'VALIDATING'] as const)(
    'resumes atomic publication from the persisted %s stage after a worker exit',
    async (stage) => {
      const suffix = stage === 'CUE_SEGMENTING' ? '21' : '22'
      const { asset, run } = await createRun(shortPath, 30_000, suffix)
      const moss = new FakeMossAdapter()
      const seed = createTranscriptProcessor({ database, storage, moss, env, workerId: `g3-stage-seed-${stage}` })
      await seed({ mediaAssetId: asset.id, processingRunId: run.id })
      const chunk = await database.processingChunk.findFirstOrThrow({ where: { processingRunId: run.id } })
      const result = { language: 'en' as const, words: [
        { text: 'Resume', startMs: 500, endMs: 1_000 }, { text: 'safely.', startMs: 1_100, endMs: 1_700 },
      ] }
      const bytes = Buffer.from(JSON.stringify(result))
      const resultChecksum = createHash('sha256').update(bytes).digest('hex')
      const temporary = join(directory, `resume-${stage}.json`)
      await writeFile(temporary, bytes)
      const object = await storage.uploadFile(
        `owners/${asset.ownerId}/asr/${asset.id}/${run.id}/resume-${stage}.json`, temporary, 'application/json',
      )
      await database.$transaction([
        database.mediaObject.create({ data: {
          mediaAssetId: asset.id, kind: 'ASR_RAW', bucket: object.bucket, objectKey: object.objectKey,
          versionId: object.versionId, contentType: 'application/json', sizeBytes: BigInt(object.sizeBytes),
          checksumSha256: resultChecksum, etag: object.etag,
          metadata: { processingRunId: run.id, chunkIndex: chunk.chunkIndex, uploadState: 'READY' },
        } }),
        database.processingChunk.update({
          where: { id: chunk.id }, data: {
            status: 'SUCCEEDED', resultObjectKey: object.objectKey, resultVersionId: object.versionId,
            resultChecksum, wordCount: result.words.length, completedAt: new Date(), nextPollAt: null,
            leaseOwner: null, leaseExpiresAt: null,
          },
        }),
        database.processingRun.update({
          where: { id: run.id }, data: { status: 'QUEUED', stage, leaseOwner: null, leaseExpiresAt: null },
        }),
      ])
      const replacement = createTranscriptProcessor({ database, storage, moss, env, workerId: `g3-stage-replacement-${stage}` })
      await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ completed: true })
      expect(await database.transcriptVersion.count({ where: { mediaAssetId: asset.id, status: 'ACTIVE' } })).toBe(1)
    },
    120_000,
  )

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

  it('purges an untracked response-loss version by its exact identity without leaving an anonymous object', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '27')
    const moss = new FakeMossAdapter()
    let loseFirstResponse = true
    const responseLosingStorage = wrapStorage({
      uploadFile: async (objectKey, filePath, contentType) => {
        const uploaded = await storage.uploadFile(objectKey, filePath, contentType)
        if (objectKey.endsWith('/normalized.wav') && loseFirstResponse) {
          loseFirstResponse = false
          throw new Error('simulated_cleanup_response_loss')
        }
        return uploaded
      },
    })
    const worker = createTranscriptProcessor({
      database, storage: responseLosingStorage, moss, env, workerId: 'g3-worker-object-cleanup-gap',
    })
    await expect(worker({ mediaAssetId: asset.id, processingRunId: run.id })).rejects.toThrow('simulated_cleanup_response_loss')
    const pending = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' },
    })
    expect(pending.versionId).toBeNull()
    const orphan = await storage.statObject(pending.objectKey, null)
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id },
        data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
      }),
      database.mediaObject.update({
        where: { id: pending.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
      }),
    ])

    let unsafeRemoveCalls = 0
    const versionlessStorage = wrapStorage({
      statObject: async (objectKey, versionId) => ({
        ...await storage.statObject(objectKey, versionId), versionId: null,
      }),
      remove: async (objectKey, versionId) => {
        unsafeRemoveCalls += 1
        return storage.remove(objectKey, versionId)
      },
    })
    await expect(cleanupTranscriptObjects(database, versionlessStorage)).resolves.toMatchObject({ cleaned: 0, failed: 1 })
    expect(unsafeRemoveCalls).toBe(0)
    expect((await database.mediaObject.findUniqueOrThrow({ where: { id: pending.id } })).purgedAt).toBeNull()

    await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 1, failed: 0 })
    const purged = await database.mediaObject.findUniqueOrThrow({ where: { id: pending.id } })
    expect(purged.versionId).toBe(orphan.versionId)
    expect(purged.purgedAt).not.toBeNull()
    await expect(storage.statObject(pending.objectKey, orphan.versionId)).rejects.toBeTruthy()
  }, 120_000)

  it('reopens a missing PENDING fact when its upload arrives after terminal cleanup, then removes the exact version', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '29')
    let releaseUpload!: () => void
    let signalUpload!: () => void
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
    const uploadStarted = new Promise<void>((resolve) => { signalUpload = resolve })
    const delayedStorage = wrapStorage({
      uploadFile: async (objectKey, filePath, contentType) => {
        if (objectKey.endsWith('/normalized.wav')) {
          signalUpload()
          await uploadGate
        }
        return storage.uploadFile(objectKey, filePath, contentType)
      },
    })
    const processor = createTranscriptProcessor({
      database, storage: delayedStorage, moss: new FakeMossAdapter(), env, workerId: 'g3-late-upload',
    })
    const processing = processor({ mediaAssetId: asset.id, processingRunId: run.id })
    await uploadStarted
    const pending = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO', versionId: null },
    })
    await database.$transaction([
      database.processingRun.update({
        where: { id: run.id },
        data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
      }),
      database.mediaObject.update({
        where: { id: pending.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
      }),
    ])
    await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 1, failed: 0 })
    expect((await database.mediaObject.findUniqueOrThrow({ where: { id: pending.id } })).purgedAt).not.toBeNull()

    releaseUpload()
    await expect(processing).resolves.toMatchObject({ skipped: true, leaseLost: true })
    const arrived = await database.mediaObject.findUniqueOrThrow({ where: { id: pending.id } })
    expect(arrived.versionId).not.toBeNull()
    expect(arrived.deletedAt).not.toBeNull()
    expect(arrived.purgedAt).toBeNull()
    await expect(storage.statObject(arrived.objectKey, arrived.versionId)).resolves.toMatchObject({ versionId: arrived.versionId })

    await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 1, failed: 0 })
    expect((await database.mediaObject.findUniqueOrThrow({ where: { id: pending.id } })).purgedAt).not.toBeNull()
    await expect(storage.statObject(arrived.objectKey, arrived.versionId)).rejects.toBeTruthy()
  }, 120_000)

  it('preserves database identities for every surviving object version when replacing corrupted latest data', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '25')
    const moss = new FakeMossAdapter()
    const seed = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-version-seed' })
    await seed({ mediaAssetId: asset.id, processingRunId: run.id })
    const original = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' },
    })
    await database.$transaction([
      database.processingChunk.deleteMany({ where: { processingRunId: run.id } }),
      database.processingRun.update({
        where: { id: run.id }, data: {
          status: 'QUEUED', stage: 'PLAYBACK_READY', errorCode: null,
          leaseOwner: null, leaseExpiresAt: null,
        },
      }),
    ])
    const corruptingStorage = wrapStorage({
      downloadFile: async (objectKey, filePath, versionId) => {
        await storage.downloadFile(objectKey, filePath, versionId)
        if (objectKey === original.objectKey && versionId === original.versionId) {
          await writeFile(filePath, 'not-the-recorded-normalized-audio')
        }
      },
    })
    const replacement = createTranscriptProcessor({
      database, storage: corruptingStorage, moss, env, workerId: 'g3-version-replacement',
    })
    await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })

    const versions = await database.mediaObject.findMany({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' }, orderBy: { createdAt: 'asc' },
    })
    expect(versions).toHaveLength(2)
    expect(versions.map((item) => item.versionId)).toContain(original.versionId)
    expect(versions.every((item) => item.versionId !== null)).toBe(true)
    const current = versions.find((item) => item.deletedAt === null)!
    expect(current.versionId).not.toBe(original.versionId)
    await expect(storage.statObject(original.objectKey, original.versionId)).resolves.toMatchObject({ versionId: original.versionId })
    await expect(storage.statObject(current.objectKey, current.versionId)).resolves.toMatchObject({ versionId: current.versionId })
  }, 120_000)

  it('lets a replacement adopt a committed object while the stale upload response is still delayed', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '17')
    const moss = new FakeMossAdapter()
    let releaseOldUpload!: () => void
    let signalOldUpload!: () => void
    const oldUploadGate = new Promise<void>((resolve) => { releaseOldUpload = resolve })
    const oldUploadStarted = new Promise<void>((resolve) => { signalOldUpload = resolve })
    const staleStorage = wrapStorage({
      uploadFile: async (objectKey, filePath, contentType) => {
        const uploaded = await storage.uploadFile(objectKey, filePath, contentType)
        if (objectKey.endsWith('/normalized.wav')) {
          signalOldUpload()
          await oldUploadGate
        }
        return uploaded
      },
    })
    const processor = createTranscriptProcessor({ database, storage: staleStorage, moss, env, workerId: 'g3-shared-process' })
    const staleProcessing = processor({ mediaAssetId: asset.id, processingRunId: run.id })
    await oldUploadStarted
    const staleLease = (await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).leaseOwner
    await database.processingRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } })
    const replacementProcessing = processor({ mediaAssetId: asset.id, processingRunId: run.id })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const current = await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })
      if (current.leaseOwner?.startsWith('g3-shared-process:') && current.leaseOwner !== staleLease) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const replacementLease = (await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).leaseOwner
    expect(replacementLease).toMatch(/^g3-shared-process:/)
    expect(replacementLease).not.toBe(staleLease)
    await expect(replacementProcessing).resolves.toMatchObject({ waiting: true })
    releaseOldUpload()
    await expect(staleProcessing).resolves.toMatchObject({ skipped: true, leaseLost: true })
    const normalized = await database.mediaObject.findMany({ where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' } })
    expect(normalized).toHaveLength(1)
    const current = normalized[0]
    expect(current.versionId).not.toBeNull()
    expect(current.deletedAt).toBeNull()
    expect((current.metadata as { uploadState?: string }).uploadState).toBe('READY')
    await expect(storage.statObject(current.objectKey, current.versionId)).resolves.toMatchObject({ objectKey: current.objectKey })
  }, 120_000)

  it.each(['before-upload', 'after-upload'] as const)(
    'recovers a durable object identity after an actual worker process is killed %s',
    async (crashPoint) => {
      const suffix = crashPoint === 'before-upload' ? '18' : '19'
      const { asset, run } = await createRun(shortPath, 30_000, suffix)
      const workerRoot = join(__dirname, '..', '..')
      const fixture = join('src', 'test-fixtures', 'transcript-crash-worker-child.ts')
      const tsxCli = require.resolve('tsx/cli')
      const child = spawn(process.execPath, [tsxCli, fixture], {
        cwd: workerRoot, windowsHide: true,
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test',
          MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000',
          MINIO_ACCESS_KEY: 'online_learning', MINIO_SECRET_KEY: 'online_learning_secret',
          MINIO_BUCKET: 'echoflow-g3-worker-test', FFMPEG_PATH: 'ffmpeg',
          G3_TEST_MEDIA_ASSET_ID: asset.id, G3_TEST_PROCESSING_RUN_ID: run.id,
          G3_TEST_CRASH_POINT: crashPoint,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stopChild = async (target: ChildProcess) => {
        if (target.exitCode !== null || target.signalCode !== null) return
        const exited = new Promise<void>((resolve) => target.once('exit', () => resolve()))
        if (process.platform === 'win32' && target.pid) {
          await execFileAsync('taskkill', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
        } else target.kill('SIGKILL')
        await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('g3_child_kill_timeout')), 5_000))])
      }
      try {
        await new Promise<void>((resolve, reject) => {
          let output = ''
          const timeout = setTimeout(() => reject(new Error('g3_crash_point_timeout')), 30_000)
          child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8')
            if (output.includes('g3_crash_point_reached')) {
              clearTimeout(timeout)
              resolve()
            }
          })
          child.once('exit', (code) => {
            if (!output.includes('g3_crash_point_reached')) {
              clearTimeout(timeout)
              reject(new Error(`g3_crash_child_exited_${String(code)}`))
            }
          })
        })
        await stopChild(child)
        const pending = await database.mediaObject.findFirstOrThrow({
          where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' },
        })
        expect(pending.versionId).toBeNull()
        expect((pending.metadata as { uploadState?: string }).uploadState).toBe('PENDING')
        await database.processingRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } })
        let normalizedUploads = 0
        const observedStorage = wrapStorage({
          uploadFile: async (objectKey, filePath, contentType) => {
            if (objectKey.endsWith('/normalized.wav')) normalizedUploads += 1
            return storage.uploadFile(objectKey, filePath, contentType)
          },
        })
        const replacement = createTranscriptProcessor({
          database, storage: observedStorage, moss: new FakeMossAdapter(), env, workerId: `g3-crash-replacement-${crashPoint}`,
        })
        await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ waiting: true })
        expect(normalizedUploads).toBe(crashPoint === 'before-upload' ? 1 : 0)
        const recovered = await database.mediaObject.findMany({ where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' } })
        expect(recovered).toHaveLength(crashPoint === 'before-upload' ? 2 : 1)
        expect(recovered.filter((item) => (item.metadata as { uploadState?: string }).uploadState === 'READY')).toHaveLength(1)
        expect(recovered.filter((item) => item.versionId === null)).toHaveLength(crashPoint === 'before-upload' ? 1 : 0)
      } finally {
        await stopChild(child)
      }
    },
    120_000,
  )

  it('keeps an existing READY version addressable after a replacement worker is killed before upload', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '26')
    const moss = new FakeMossAdapter()
    const seed = createTranscriptProcessor({ database, storage, moss, env, workerId: 'g3-existing-version-seed' })
    await seed({ mediaAssetId: asset.id, processingRunId: run.id })
    const original = await database.mediaObject.findFirstOrThrow({
      where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' },
    })
    await database.$transaction([
      database.mediaObject.update({
        where: { id: original.id }, data: { checksumSha256: '0'.repeat(64) },
      }),
      database.processingChunk.deleteMany({ where: { processingRunId: run.id } }),
      database.processingRun.update({
        where: { id: run.id }, data: {
          status: 'QUEUED', stage: 'PLAYBACK_READY', errorCode: null,
          leaseOwner: null, leaseExpiresAt: null,
        },
      }),
    ])
    const workerRoot = join(__dirname, '..', '..')
    const fixture = join('src', 'test-fixtures', 'transcript-crash-worker-child.ts')
    const tsxCli = require.resolve('tsx/cli')
    const child = spawn(process.execPath, [tsxCli, fixture], {
      cwd: workerRoot, windowsHide: true,
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test',
        MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000',
        MINIO_ACCESS_KEY: 'online_learning', MINIO_SECRET_KEY: 'online_learning_secret',
        MINIO_BUCKET: 'echoflow-g3-worker-test', FFMPEG_PATH: 'ffmpeg',
        G3_TEST_MEDIA_ASSET_ID: asset.id, G3_TEST_PROCESSING_RUN_ID: run.id,
        G3_TEST_CRASH_POINT: 'before-upload',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stopChild = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      if (process.platform === 'win32' && child.pid) {
        await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      } else child.kill('SIGKILL')
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('g3_existing_child_kill_timeout')), 5_000))])
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => reject(new Error('g3_existing_crash_point_timeout')), 30_000)
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
          if (output.includes('g3_crash_point_reached')) {
            clearTimeout(timeout)
            resolve()
          }
        })
        child.once('exit', (code) => {
          if (!output.includes('g3_crash_point_reached')) {
            clearTimeout(timeout)
            reject(new Error(`g3_existing_crash_child_exited_${String(code)}`))
          }
        })
      })
      await stopChild()
      const reserved = await database.mediaObject.findMany({
        where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO' },
      })
      expect(reserved).toHaveLength(2)
      expect(reserved.map((item) => item.versionId)).toEqual(expect.arrayContaining([original.versionId, null]))
      await expect(storage.statObject(original.objectKey, original.versionId)).resolves.toMatchObject({ versionId: original.versionId })

      await database.$transaction([
        database.processingRun.update({
          where: { id: run.id }, data: { status: 'CANCELLED', errorCode: 'processing_cancelled', leaseOwner: null, leaseExpiresAt: null },
        }),
        database.mediaObject.updateMany({
          where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO', versionId: null },
          data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
        }),
      ])
      await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 1, failed: 0 })
      expect(await database.mediaObject.count({
        where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO', purgedAt: { not: null } },
      })).toBe(1)
      await expect(storage.statObject(original.objectKey, original.versionId)).resolves.toMatchObject({ versionId: original.versionId })

      await database.mediaObject.update({
        where: { id: original.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
      })
      await expect(cleanupTranscriptObjects(database, storage)).resolves.toMatchObject({ cleaned: 1, failed: 0 })
      await expect(storage.statObject(original.objectKey, original.versionId)).rejects.toBeTruthy()
      expect((await database.mediaObject.findFirstOrThrow({
        where: { mediaAssetId: asset.id, kind: 'NORMALIZED_AUDIO', versionId: null },
      })).purgedAt).not.toBeNull()
    } finally {
      await stopChild()
    }
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

  it('rebuilds a recoverable transcript job into a real empty Redis queue from PostgreSQL', async () => {
    const { asset, run } = await createRun(shortPath, 30_000, '9')
    await database.processingRun.update({
      where: { id: run.id }, data: { status: 'PROCESSING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(0) },
    })
    const connection = new IORedis('redis://localhost:6379', { maxRetriesPerRequest: null })
    const queue = new Queue(`echoflow-g3-recovery-${crypto.randomUUID()}`, { connection })
    try {
      expect(await queue.count()).toBe(0)
      await expect(enqueueRecoverableTranscriptRuns(database, queue)).resolves.toEqual({ enqueued: 1 })
      const jobs = await queue.getJobs(['wait'])
      expect(jobs).toHaveLength(1)
      expect(jobs[0].name).toBe('media.transcript_process')
      expect(jobs[0].data).toEqual({ mediaAssetId: asset.id, processingRunId: run.id })
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
      await connection.quit()
    }
  }, 120_000)
})
