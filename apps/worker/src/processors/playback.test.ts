import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PrismaClient } from '@online-learning/database'
import { MinioStorageProvider } from '@online-learning/storage'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackProcessor, UnsupportedMediaError, validateMediaMetadata } from './playback'
import { cleanupExpiredUploads } from './upload-cleanup'
import { enqueueRecoverableRuns, publishPendingOutbox } from '../outbox'

const execFileAsync = promisify(execFile)
const database = new PrismaClient({
  datasources: { db: { url: 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test' } },
})
const storage = new MinioStorageProvider({
  endPoint: 'localhost', port: 9000, useSSL: false,
  accessKey: 'online_learning', secretKey: 'online_learning_secret', bucket: 'echoflow-g2-worker-test',
})
const replacementStorage = new MinioStorageProvider({
  endPoint: 'localhost', port: 9000, useSSL: false,
  accessKey: 'online_learning', secretKey: 'online_learning_secret', bucket: 'echoflow-g2-worker-test',
})
let temporaryDirectory = ''
let sample: Buffer
let sampleWithoutFastStart: Buffer

async function uploadObject(objectKey: string, bytes: Buffer) {
  const providerUploadId = await storage.createMultipartUpload(objectKey, 'video/mp4')
  const url = await storage.createPartUploadUrl(objectKey, providerUploadId, 1, 900)
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const response = await fetch(url, { method: 'PUT', body })
  expect(response.status).toBe(200)
  const parts = await storage.listMultipartParts(objectKey, providerUploadId)
  const completed = await storage.completeMultipartUpload(objectKey, providerUploadId, parts)
  return storage.statObject(objectKey, completed.versionId)
}

async function createRun(suffix: string, media = sample) {
  const user = await database.user.create({
    data: { phone: `+8613900${suffix.padStart(6, '0')}`, displayName: `Worker ${suffix}` },
  })
  const objectKey = `g2-worker/${crypto.randomUUID()}.mp4`
  const object = await uploadObject(objectKey, media)
  const asset = await database.mediaAsset.create({
    data: {
      ownerId: user.id, title: `Sample ${suffix}`, originalName: 'sample.mp4',
      objects: {
        create: {
          kind: 'ORIGINAL', bucket: storage.bucket, objectKey, versionId: object.versionId,
          contentType: 'video/mp4', sizeBytes: BigInt(object.sizeBytes), etag: object.etag,
        },
      },
    },
  })
  const run = await database.processingRun.create({
    data: { ownerId: user.id, mediaAssetId: asset.id, pipelineVersion: 'g2-playback-v1' },
  })
  return { asset, run }
}

describe('G2 real playback preparation', () => {
  beforeAll(async () => {
    await storage.ensureBucket()
    await storage.ensureVersioning()
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'echoflow-g2-worker-'))
    const path = join(temporaryDirectory, 'sample.mp4')
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-movflags', '+faststart', '-y', path,
    ], { windowsHide: true, timeout: 120_000 })
    sample = await readFile(path)
    const slowStartPath = join(temporaryDirectory, 'sample-slow-start.mp4')
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', slowStartPath,
    ], { windowsHide: true, timeout: 120_000 })
    sampleWithoutFastStart = await readFile(slowStartPath)
    await database.$connect()
  })

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        "AuditEvent", "IdempotencyRecord", "LearningProgress", "LearningUnit", "PrivateLesson",
        "SubtitleCue", "TranscriptVersion", "OutboxEvent", "ProcessingChunk", "ProcessingRun",
        "MediaObject", "MediaAsset", "UploadPart", "UploadSession", "RefreshSession",
        "OtpChallenge", "User"
      CASCADE
    `)
  })

  afterAll(async () => {
    await database.$disconnect()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('accepts the three-hour architecture boundary without duration overflow', () => {
    const metadata = { container: 'mov,mp4', videoCodec: 'h264', audioCodec: 'aac', fastStart: true }
    expect(validateMediaMetadata({ ...metadata, durationSeconds: 3 * 60 * 60 }).durationMs).toBe(10_800_000)
    expect(() => validateMediaMetadata({ ...metadata, durationSeconds: 3 * 60 * 60 + 0.001 })).toThrow('duration_out_of_range')
  })

  it('downloads a private MP4 without exposing a signed URL and publishes PLAYABLE exactly once', async () => {
    const { asset, run } = await createRun('1')
    const signedUrlSpy = vi.spyOn(storage, 'createReadUrl')
    const processPlayback = createPlaybackProcessor({
      database, storage, workerId: 'worker-real', ffprobePath: 'ffprobe',
    })
    const result = await processPlayback({ mediaAssetId: asset.id, processingRunId: run.id })
    expect(result).toMatchObject({ skipped: false, failed: false, videoCodec: 'h264', audioCodec: 'aac' })
    const [storedAsset, storedRun, readyEvents] = await Promise.all([
      database.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
      database.processingRun.findUniqueOrThrow({ where: { id: run.id } }),
      database.outboxEvent.count({ where: { eventType: 'media.playback_ready' } }),
    ])
    expect(storedAsset.status).toBe('PLAYABLE')
    expect(storedAsset.durationMs).toBeGreaterThanOrEqual(29_000)
    expect(storedRun).toMatchObject({ status: 'SUCCEEDED', stage: 'PLAYBACK_READY' })
    expect(readyEvents).toBe(1)
    expect(signedUrlSpy).not.toHaveBeenCalled()
    expect(await processPlayback({ mediaAssetId: asset.id, processingRunId: run.id })).toMatchObject({ skipped: true })
    expect(await database.outboxEvent.count({ where: { eventType: 'media.playback_ready' } })).toBe(1)
    signedUrlSpy.mockRestore()
  })

  it('separates terminal format errors from retryable probe failures', async () => {
    const terminal = await createRun('2')
    const rejectFormat = createPlaybackProcessor({
      database, storage, workerId: 'worker-terminal', ffprobePath: 'ffprobe',
      probe: async () => { throw new UnsupportedMediaError('video_codec_not_h264') },
    })
    await expect(rejectFormat({ mediaAssetId: terminal.asset.id, processingRunId: terminal.run.id }))
      .resolves.toMatchObject({ failed: true, errorCode: 'media_format_unsupported' })
    expect(await database.mediaAsset.findUniqueOrThrow({ where: { id: terminal.asset.id } })).toMatchObject({ status: 'FAILED' })

    const retryable = await createRun('3')
    const transientFailure = createPlaybackProcessor({
      database, storage, workerId: 'worker-retry', ffprobePath: 'ffprobe',
      probe: async () => { throw new Error('temporary ffprobe failure') },
    })
    await expect(transientFailure({ mediaAssetId: retryable.asset.id, processingRunId: retryable.run.id })).rejects.toThrow('temporary')
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: retryable.run.id } }))
      .toMatchObject({ status: 'QUEUED', stage: 'UPLOAD_VERIFIED', attempt: 1, errorCode: 'media_probe_retryable' })
  })

  it('keeps the original immutable and creates a fast-start playback object when moov is after mdat', async () => {
    const { asset, run } = await createRun('6', sampleWithoutFastStart)
    const processPlayback = createPlaybackProcessor({
      database, storage, workerId: 'worker-remux', ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg',
    })
    await expect(processPlayback({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ fastStart: false, failed: false })
    const objects = await database.mediaObject.findMany({ where: { mediaAssetId: asset.id }, orderBy: { createdAt: 'asc' } })
    expect(objects.map((object) => object.kind)).toEqual(['ORIGINAL', 'PLAYBACK'])
    expect(objects[0].objectKey).not.toBe(objects[1].objectKey)
    const playbackUrl = await storage.createReadUrl(objects[1].objectKey, 900, objects[1].versionId)
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', playbackUrl], {
      windowsHide: true,
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' },
    })
    expect(Number((JSON.parse(stdout) as { format: { duration: string } }).format.duration)).toBeGreaterThan(0)
  })

  it('aborts and expires abandoned multipart uploads after seven days', async () => {
    const user = await database.user.create({ data: { phone: '+8613900000004', displayName: 'Expired' } })
    const objectKey = `g2-worker/${crypto.randomUUID()}.mp4`
    const providerUploadId = await storage.createMultipartUpload(objectKey, 'video/mp4')
    const upload = await database.uploadSession.create({
      data: {
        ownerId: user.id, title: 'Expired', originalName: 'expired.mp4', contentType: 'video/mp4',
        sizeBytes: 100n, fileFingerprint: 'd'.repeat(64), bucket: storage.bucket, objectKey,
        providerUploadId, partSizeBytes: 5_242_880n, expiresAt: new Date(Date.now() - 1_000),
      },
    })
    await expect(cleanupExpiredUploads(database, storage)).resolves.toMatchObject({ cleaned: 1, failed: 0 })
    expect(await database.uploadSession.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({ status: 'EXPIRED' })
    await expect(storage.listMultipartParts(objectKey, providerUploadId)).rejects.toMatchObject({ code: 'NoSuchUpload' })
  })

  it('rechecks status under the shared lock before cleaning an upload completed concurrently', async () => {
    const user = await database.user.create({ data: { phone: '+8613900000010', displayName: 'Cleanup race' } })
    const objectKey = `g2-worker/${crypto.randomUUID()}.mp4`
    const providerUploadId = await storage.createMultipartUpload(objectKey, 'video/mp4')
    const upload = await database.uploadSession.create({
      data: {
        ownerId: user.id, title: 'Cleanup race', originalName: 'race.mp4', contentType: 'video/mp4',
        sizeBytes: 100n, fileFingerprint: 'e'.repeat(64), bucket: storage.bucket, objectKey,
        providerUploadId, partSizeBytes: 5_242_880n, expiresAt: new Date(Date.now() - 1_000),
      },
    })
    let signalLocked!: () => void
    let releaseLock!: () => void
    const locked = new Promise<void>((resolve) => { signalLocked = resolve })
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve })
    const completing = database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${upload.id}, 0))`
      signalLocked()
      await lockGate
      await transaction.uploadSession.update({ where: { id: upload.id }, data: { status: 'COMPLETED', completedAt: new Date() } })
    }, { timeout: 60_000 })
    await locked
    const cleaning = cleanupExpiredUploads(database, storage)
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseLock()
    await completing

    await expect(cleaning).resolves.toMatchObject({ cleaned: 0, failed: 0 })
    await expect(storage.listMultipartParts(objectKey, providerUploadId)).resolves.toEqual([])
    await storage.abortMultipartUpload(objectKey, providerUploadId)
  })

  it('reclaims a PROBING run after the previous worker lease expires', async () => {
    const { asset, run } = await createRun('5')
    await database.processingRun.update({
      where: { id: run.id },
      data: { status: 'PROCESSING', stage: 'PROBING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 1_000) },
    })
    const recovered = createPlaybackProcessor({
      database, storage, workerId: 'recovery-worker', ffprobePath: 'ffprobe',
      probe: async () => ({ durationMs: 1_000, container: 'mov,mp4', videoCodec: 'h264', audioCodec: 'aac', fastStart: true }),
    })
    await expect(recovered({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ failed: false })
    expect(await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', stage: 'PLAYBACK_READY' })
  })

  it('recovers the same BullMQ job after an actual worker process is killed and restarted', async () => {
    const { asset, run } = await createRun('11')
    const connection = new IORedis('redis://localhost:6379', { maxRetriesPerRequest: null })
    const queueName = `echoflow-g2-restart-${crypto.randomUUID()}`
    const queue = new Queue(queueName, { connection })
    const children: ChildProcess[] = []
    const workerRoot = join(__dirname, '..', '..')
    const fixture = join('src', 'test-fixtures', 'restart-worker-child.ts')
    const tsxCli = require.resolve('tsx/cli')
    const childEnvironment = {
      ...process.env,
      DATABASE_URL: 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_worker_test',
      REDIS_URL: 'redis://localhost:6379',
      MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000',
      MINIO_ACCESS_KEY: 'online_learning', MINIO_SECRET_KEY: 'online_learning_secret',
      MINIO_BUCKET: 'echoflow-g2-worker-test',
      G2_TEST_QUEUE_NAME: queueName, FFPROBE_PATH: 'ffprobe', FFMPEG_PATH: 'ffmpeg',
    }
    const startChild = (hang: boolean) => {
      const child = spawn(process.execPath, [tsxCli, fixture], {
        cwd: workerRoot, windowsHide: true,
        env: { ...childEnvironment, G2_TEST_HANG_PROBE: String(hang) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    }
    const stopChild = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      if (process.platform === 'win32' && child.pid) {
        await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
      } else child.kill('SIGKILL')
      const stopped = await Promise.race([exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))])
      if (!stopped) {
        throw new Error('worker_child_failed_to_exit')
      }
    }
    const waitForRun = async (predicate: (status: string, stage: string) => boolean, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await database.processingRun.findUniqueOrThrow({ where: { id: run.id } })
        if (predicate(current.status, current.stage)) return current
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('worker_restart_state_timeout')
    }
    try {
      await queue.add('media.upload_verified', { mediaAssetId: asset.id, processingRunId: run.id }, {
        jobId: `processing-${run.id}-0`, attempts: 1,
      })
      const first = startChild(true)
      await waitForRun((status, stage) => status === 'PROCESSING' && stage === 'PROBING')
      await stopChild(first)
      await database.processingRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } })

      const replacement = startChild(false)
      const completed = await waitForRun((status, stage) => status === 'SUCCEEDED' && stage === 'PLAYBACK_READY')
      expect(completed.leaseOwner).toBeNull()
      expect(await database.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ status: 'PLAYABLE' })
      expect(await database.outboxEvent.count({ where: { aggregateId: asset.id, eventType: 'media.playback_ready' } })).toBe(1)
      await stopChild(replacement)
    } finally {
      await Promise.all(children.map((child) => stopChild(child)))
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
      await connection.quit()
    }
  }, 60_000)

  it('fences a worker that loses its database lease before publishing playback', async () => {
    const { asset, run } = await createRun('8')
    let releaseProbe!: () => void
    let signalProbeStarted!: () => void
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
    const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve })
    const processor = createPlaybackProcessor({
      database, storage, workerId: 'old-worker', ffprobePath: 'ffprobe',
      probe: async () => {
        signalProbeStarted()
        await probeGate
        return { durationMs: 1_000, container: 'mov,mp4', videoCodec: 'h264', audioCodec: 'aac', fastStart: true }
      },
    })
    const processing = processor({ mediaAssetId: asset.id, processingRunId: run.id })
    await probeStarted
    await database.processingRun.update({
      where: { id: run.id },
      data: { leaseOwner: 'replacement-worker', leaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    releaseProbe()

    await expect(processing).resolves.toMatchObject({ skipped: true, status: 'lease_lost' })
    expect(await database.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ status: 'PROCESSING_PLAYBACK' })
    expect(await database.outboxEvent.count({ where: { eventType: 'media.playback_ready' } })).toBe(0)
  })

  it('keeps a replacement worker playback object when a slow-start worker loses its lease', async () => {
    const { asset, run } = await createRun('9', sampleWithoutFastStart)
    let releaseOldUpload!: () => void
    let signalOldUpload!: () => void
    const oldUploadGate = new Promise<void>((resolve) => { releaseOldUpload = resolve })
    const oldUploadStarted = new Promise<void>((resolve) => { signalOldUpload = resolve })
    const originalUpload = storage.uploadFile.bind(storage)
    const uploadSpy = vi.spyOn(storage, 'uploadFile').mockImplementation(async (...args) => {
      const uploaded = await originalUpload(...args)
      signalOldUpload()
      await oldUploadGate
      return uploaded
    })
    const oldProcessor = createPlaybackProcessor({
      database, storage, workerId: 'old-slow-worker', ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg',
    })
    const oldProcessing = oldProcessor({ mediaAssetId: asset.id, processingRunId: run.id })
    await oldUploadStarted
    await database.processingRun.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    })
    const replacement = createPlaybackProcessor({
      database, storage: replacementStorage, workerId: 'replacement-slow-worker', ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg',
    })
    await expect(replacement({ mediaAssetId: asset.id, processingRunId: run.id })).resolves.toMatchObject({ failed: false })
    releaseOldUpload()
    await expect(oldProcessing).resolves.toMatchObject({ skipped: true, status: 'lease_lost' })
    uploadSpy.mockRestore()

    const playback = await database.mediaObject.findFirstOrThrow({ where: { mediaAssetId: asset.id, kind: 'PLAYBACK' } })
    expect(playback.objectKey).toContain('replacement-slow-worker')
    await expect(replacementStorage.statObject(playback.objectKey, playback.versionId)).resolves.toMatchObject({ objectKey: playback.objectKey })
    expect(await database.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ status: 'PLAYABLE' })
  })

  it('publishes Outbox idempotently and rebuilds a lost Redis queue from PostgreSQL', async () => {
    const { asset, run } = await createRun('7')
    const event = await database.outboxEvent.create({
      data: {
        aggregateType: 'MediaAsset', aggregateId: asset.id, eventType: 'media.upload_verified',
        idempotencyKey: `worker-test:${asset.id}`,
        payload: { mediaAssetId: asset.id, processingRunId: run.id, attempt: 0 },
      },
    })
    const connection = new IORedis('redis://localhost:6379', { maxRetriesPerRequest: null })
    const queue = new Queue(`echoflow-g2-${crypto.randomUUID()}`, { connection })
    try {
      await expect(publishPendingOutbox(database, queue)).resolves.toMatchObject({ published: 1 })
      expect(await queue.getJobCounts('wait', 'delayed', 'active')).toMatchObject({ wait: 1 })
      expect(await database.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'PUBLISHED', attempts: 1 })

      await database.outboxEvent.update({ where: { id: event.id }, data: { status: 'PENDING', availableAt: new Date() } })
      await expect(publishPendingOutbox(database, queue)).resolves.toMatchObject({ published: 1 })
      expect((await queue.getJobs(['wait'])).filter((job) => job.id === `processing-${run.id}-0`)).toHaveLength(1)

      await queue.obliterate({ force: true })
      expect(await queue.count()).toBe(0)
      await expect(enqueueRecoverableRuns(database, queue)).resolves.toMatchObject({ enqueued: 1 })
      expect(await queue.count()).toBe(1)
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
      await connection.quit()
    }
  })
})
