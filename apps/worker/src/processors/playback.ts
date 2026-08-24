import { execFile } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MAX_UPLOAD_DURATION_MS } from '@online-learning/contracts'
import { Prisma, type PrismaClient } from '@online-learning/database'
import type { MultipartStorageProvider } from '@online-learning/storage'
import { G3_PIPELINE_VERSION } from '../transcript/constants'

const execFileAsync = promisify(execFile)

export type PlaybackJob = { mediaAssetId: string; processingRunId: string; attempt?: number }
export type ProbeResult = {
  durationMs: number
  container: string
  videoCodec: string
  audioCodec: string
  fastStart: boolean
}

type ProbeJson = {
  format?: { format_name?: string; duration?: string }
  streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string }>
}

export class UnsupportedMediaError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

class PlaybackLeaseLostError extends Error {}

function unsupportedMediaErrorCode(error: UnsupportedMediaError) {
  return error.reason === 'duration_out_of_range' ? 'media_duration_unsupported' : 'media_format_unsupported'
}

export function validateMediaMetadata(input: {
  container: string
  videoCodec: string
  audioCodec: string
  durationSeconds: number
  fastStart: boolean
}): ProbeResult {
  if (!input.container.split(',').some((name) => name === 'mov' || name === 'mp4')) throw new UnsupportedMediaError('container_not_mp4')
  if (input.videoCodec !== 'h264') throw new UnsupportedMediaError('video_codec_not_h264')
  if (input.audioCodec !== 'aac') throw new UnsupportedMediaError('audio_codec_not_aac')
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > MAX_UPLOAD_DURATION_MS / 1000) {
    throw new UnsupportedMediaError('duration_out_of_range')
  }
  return {
    durationMs: Math.round(input.durationSeconds * 1000),
    container: input.container,
    videoCodec: input.videoCodec,
    audioCodec: input.audioCodec,
    fastStart: input.fastStart,
  }
}

const noProxyEnvironment = {
  ...process.env,
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  http_proxy: '', https_proxy: '', all_proxy: '',
}

async function readLayoutBytes(mediaSource: string) {
  if (/^https?:\/\//i.test(mediaSource)) {
    const response = await fetch(mediaSource, { headers: { Range: 'bytes=0-8388607' } })
    if (!response.ok) throw new Error('mp4_layout_read_failed')
    return new Uint8Array(await response.arrayBuffer())
  }
  const handle = await open(mediaSource, 'r')
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function inspectFastStart(mediaSource: string) {
  const bytes = await readLayoutBytes(mediaSource)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 8 <= bytes.length) {
    let boxSize = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    let headerSize = 8
    if (boxSize === 1) {
      if (offset + 16 > bytes.length) break
      const extended = view.getBigUint64(offset + 8)
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('mp4_box_too_large')
      boxSize = Number(extended)
      headerSize = 16
    }
    if (type === 'moov') return true
    if (type === 'mdat') return false
    if (boxSize === 0 || boxSize < headerSize) break
    offset += boxSize
  }
  throw new Error('mp4_layout_unknown')
}

export async function probeMedia(ffprobePath: string, mediaSource: string): Promise<ProbeResult> {
  let stdout: string
  try {
    const result = await execFileAsync(ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mediaSource,
    ], {
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
      env: noProxyEnvironment,
    })
    stdout = result.stdout
  } catch {
    throw new Error('ffprobe_execution_failed')
  }
  let parsed: ProbeJson
  try {
    parsed = JSON.parse(stdout) as ProbeJson
  } catch {
    throw new Error('ffprobe_invalid_json')
  }
  const container = parsed.format?.format_name ?? ''
  const videoCodec = parsed.streams?.find((stream) => stream.codec_type === 'video')?.codec_name ?? ''
  const audioCodec = parsed.streams?.find((stream) => stream.codec_type === 'audio')?.codec_name ?? ''
  const durationSeconds = Number(parsed.format?.duration ?? parsed.streams?.[0]?.duration)
  const fastStart = await inspectFastStart(mediaSource)
  return validateMediaMetadata({ container, videoCodec, audioCodec, durationSeconds, fastStart })
}

async function remuxFastStart(ffmpegPath: string, inputPath: string, outputPath: string) {
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-y', outputPath,
    ], { windowsHide: true, maxBuffer: 5 * 1024 * 1024, timeout: 6 * 60 * 60_000, env: noProxyEnvironment })
  } catch {
    throw new Error('faststart_remux_failed')
  }
}

type PlaybackProcessorOptions = {
  database: PrismaClient
  storage: MultipartStorageProvider
  workerId: string
  ffprobePath: string
  ffmpegPath?: string
  probe?: (ffprobePath: string, mediaSource: string) => Promise<ProbeResult>
  now?: () => Date
  transcriptEnabled?: boolean
}

export function createPlaybackProcessor(options: PlaybackProcessorOptions) {
  const probe = options.probe ?? probeMedia
  const now = options.now ?? (() => new Date())

  return async (job: PlaybackJob) => {
    const leaseUntil = new Date(now().getTime() + 5 * 60_000)
    const claimed = await options.database.processingRun.updateMany({
      where: {
        id: job.processingRunId,
        mediaAssetId: job.mediaAssetId,
        OR: [
          { status: 'QUEUED', stage: 'UPLOAD_VERIFIED' },
          { status: 'PROCESSING', stage: 'PROBING', leaseExpiresAt: { lt: now() } },
        ],
      },
      data: {
        status: 'PROCESSING', stage: 'PROBING', leaseOwner: options.workerId,
        leaseExpiresAt: leaseUntil, startedAt: now(), errorCode: null, errorDetail: Prisma.DbNull,
      },
    })
    if (claimed.count === 0) {
      const existing = await options.database.processingRun.findUnique({ where: { id: job.processingRunId } })
      return { skipped: true, stage: existing?.stage ?? null, status: existing?.status ?? null }
    }

    const asset = await options.database.mediaAsset.findUnique({
      where: { id: job.mediaAssetId },
      include: { objects: { where: { kind: 'ORIGINAL', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    const object = asset?.objects[0]
    if (!asset || !object) {
      await options.database.processingRun.update({
        where: { id: job.processingRunId },
        data: { status: 'FAILED', failedAt: now(), errorCode: 'media_object_missing', leaseOwner: null, leaseExpiresAt: null },
      })
      if (asset) await options.database.mediaAsset.update({ where: { id: asset.id }, data: { status: 'FAILED' } })
      return { skipped: false, failed: true, errorCode: 'media_object_missing' }
    }

    const heartbeat = setInterval(() => {
      void options.database.processingRun.updateMany({
        where: {
          id: job.processingRunId,
          status: 'PROCESSING',
          leaseOwner: options.workerId,
        },
        data: { leaseExpiresAt: new Date(now().getTime() + 5 * 60_000) },
      }).catch(() => undefined)
    }, 30_000)
    heartbeat.unref()

    let workDirectory: string | null = null
    let playbackObject: Awaited<ReturnType<MultipartStorageProvider['statObject']>> | null = null
    let playbackCreated = false
    try {
      workDirectory = await mkdtemp(join(tmpdir(), 'echoflow-playback-'))
      const inputPath = join(workDirectory, 'original.mp4')
      await options.storage.downloadFile(object.objectKey, inputPath, object.versionId)
      const result = await probe(options.ffprobePath, inputPath)
      if (!result.fastStart) {
        const playbackKey = `owners/${asset.ownerId}/playback/${asset.id}/${job.processingRunId}-${options.workerId}.mp4`
        const outputPath = join(workDirectory, `${asset.id}.mp4`)
        await remuxFastStart(options.ffmpegPath ?? 'ffmpeg', inputPath, outputPath)
        playbackObject = await options.storage.uploadFile(playbackKey, outputPath, 'video/mp4')
        playbackCreated = true
      }
      await options.database.$transaction(async (transaction) => {
        const finalized = await transaction.processingRun.updateMany({
          where: {
            id: job.processingRunId,
            status: 'PROCESSING',
            stage: 'PROBING',
            leaseOwner: options.workerId,
          },
          data: {
            status: 'SUCCEEDED', stage: 'PLAYBACK_READY', completedAt: now(),
            leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorDetail: Prisma.DbNull,
          },
        })
        if (finalized.count !== 1) throw new PlaybackLeaseLostError('playback_lease_lost')
        await transaction.mediaAsset.update({
          where: { id: asset.id }, data: { status: 'PLAYABLE', durationMs: result.durationMs },
        })
        await transaction.mediaObject.update({
          where: { id: object.id },
          data: { metadata: { container: result.container, videoCodec: result.videoCodec, audioCodec: result.audioCodec, fastStart: result.fastStart } },
        })
        if (playbackObject) {
          await transaction.mediaObject.create({
            data: {
              mediaAssetId: asset.id, kind: 'PLAYBACK', bucket: playbackObject.bucket,
              objectKey: playbackObject.objectKey, versionId: playbackObject.versionId,
              contentType: 'video/mp4', sizeBytes: BigInt(playbackObject.sizeBytes), etag: playbackObject.etag,
              metadata: { fastStart: true, derivedFromObjectId: object.id },
            },
          })
        }
        if (options.transcriptEnabled ?? true) {
          const transcriptRun = await transaction.processingRun.upsert({
            where: { mediaAssetId_pipelineVersion: { mediaAssetId: asset.id, pipelineVersion: G3_PIPELINE_VERSION } },
            create: {
              ownerId: asset.ownerId, mediaAssetId: asset.id,
              pipelineVersion: G3_PIPELINE_VERSION, stage: 'PLAYBACK_READY',
            },
            update: {},
          })
          await transaction.outboxEvent.create({
            data: {
              aggregateType: 'MediaAsset', aggregateId: asset.id, eventType: 'media.playback_ready',
              idempotencyKey: `media:${asset.id}:playback_ready:${G3_PIPELINE_VERSION}`,
              payload: { mediaAssetId: asset.id, processingRunId: transcriptRun.id },
            },
          })
        }
      })
      return { skipped: false, failed: false, ...result }
    } catch (error) {
      if (error instanceof PlaybackLeaseLostError) {
        const orphan = playbackObject as Awaited<ReturnType<MultipartStorageProvider['statObject']>> | null
        if (playbackCreated && orphan) await options.storage.remove(orphan.objectKey, orphan.versionId).catch(() => undefined)
        return { skipped: true, stage: 'PROBING', status: 'lease_lost' }
      }
      if (error instanceof UnsupportedMediaError) {
        const errorCode = unsupportedMediaErrorCode(error)
        const terminalCommitted = await options.database.$transaction(async (transaction) => {
          const failed = await transaction.processingRun.updateMany({
            where: {
              id: job.processingRunId,
              status: 'PROCESSING',
              stage: 'PROBING',
              leaseOwner: options.workerId,
            },
            data: {
              status: 'FAILED', failedAt: now(), errorCode,
              errorDetail: { reason: error.reason }, leaseOwner: null, leaseExpiresAt: null,
            },
          })
          if (failed.count !== 1) throw new PlaybackLeaseLostError('playback_lease_lost')
          await transaction.mediaAsset.update({ where: { id: asset.id }, data: { status: 'FAILED' } })
        }).then(() => true).catch((failure) => {
          if (failure instanceof PlaybackLeaseLostError) return false
          throw failure
        })
        if (!terminalCommitted) return { skipped: true, stage: 'PROBING', status: 'lease_lost' }
        return { skipped: false, failed: true, errorCode }
      }
      const released = await options.database.processingRun.updateMany({
        where: {
          id: job.processingRunId,
          status: 'PROCESSING',
          stage: 'PROBING',
          leaseOwner: options.workerId,
        },
        data: {
          status: 'QUEUED', stage: 'UPLOAD_VERIFIED', errorCode: 'media_probe_retryable',
          errorDetail: { message: error instanceof Error ? error.message.slice(0, 500) : 'unknown' },
          leaseOwner: null, leaseExpiresAt: null, attempt: { increment: 1 },
        },
      })
      if (released.count === 0) return { skipped: true, stage: 'PROBING', status: 'lease_lost' }
      throw error
    } finally {
      if (workDirectory) await rm(workDirectory, { recursive: true, force: true })
      clearInterval(heartbeat)
    }
  }
}
