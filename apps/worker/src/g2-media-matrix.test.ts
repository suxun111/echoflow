import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MinioStorageProvider } from '@online-learning/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeMedia } from './processors/playback'

const execFileAsync = promisify(execFile)
const runLongMatrix = process.env.RUN_G2_LONG_MEDIA === 'true'
const matrix = [5, 30, 60, 120]

describe.skipIf(!runLongMatrix)('G2 long media matrix', () => {
  const storage = new MinioStorageProvider({
    endPoint: 'localhost', port: 9000, useSSL: false,
    accessKey: 'online_learning', secretKey: 'online_learning_secret', bucket: 'echoflow-g2-long-media-test',
  })
  let directory = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'echoflow-g2-long-'))
    await storage.ensureBucket()
    await storage.ensureVersioning()
  })

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it.each(matrix)('uploads, HEADs, probes and Range-reads a %i minute H.264/AAC MP4', async (minutes) => {
    const path = join(directory, `sample-${minutes}m.mp4`)
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
      '-t', String(minutes * 60), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart', '-y', path,
    ], { windowsHide: true, timeout: 30 * 60_000 })
    const bytes = await readFile(path)
    const objectKey = `matrix/${crypto.randomUUID()}-${minutes}m.mp4`
    const providerUploadId = await storage.createMultipartUpload(objectKey, 'video/mp4')
    const partSize = 5 * 1024 * 1024
    for (let offset = 0, partNumber = 1; offset < bytes.length; offset += partSize, partNumber += 1) {
      const url = await storage.createPartUploadUrl(objectKey, providerUploadId, partNumber, 900)
      const body = bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + Math.min(bytes.length, offset + partSize)) as ArrayBuffer
      const response = await fetch(url, { method: 'PUT', body })
      expect(response.status).toBe(200)
    }
    const parts = await storage.listMultipartParts(objectKey, providerUploadId)
    expect(parts).toHaveLength(Math.ceil(bytes.length / partSize))
    if (minutes === 120) expect(parts.length).toBeGreaterThan(1)
    expect(parts.reduce((sum, part) => sum + part.sizeBytes, 0)).toBe(bytes.length)
    const completed = await storage.completeMultipartUpload(objectKey, providerUploadId, parts)
    const object = await storage.statObject(objectKey, completed.versionId)
    expect(object.sizeBytes).toBe(bytes.length)
    expect(object.versionId).toBeTruthy()
    const readUrl = await storage.createReadUrl(objectKey, 900, object.versionId)
    const ranged = await fetch(readUrl, { headers: { Range: 'bytes=0-1023' } })
    expect(ranged.status).toBe(206)
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024)
    const result = await probeMedia('ffprobe', readUrl)
    expect(result).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', fastStart: true })
    expect(result.durationMs).toBeGreaterThanOrEqual(minutes * 60_000 - 1_000)
    expect(result.durationMs).toBeLessThanOrEqual(minutes * 60_000 + 1_000)
    await storage.remove(objectKey, object.versionId)
  }, 30 * 60_000)
})
