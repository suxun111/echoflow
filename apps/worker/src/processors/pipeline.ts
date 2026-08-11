import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { loadServerEnv, type ServerEnv } from '@online-learning/config'
import { createMinioStorageProvider, type StorageProvider } from '@online-learning/storage'
import { TranslationError, translateVolcengineBatch, translationWarning } from './volcengine-translation'

export type MediaQueueJob = { jobId: string }

export type MossSegment = {
  start: number
  end: number
  speaker: string
  text: string
}

export type NormalizedCue = {
  order: number
  startMs: number
  endMs: number
  english: string
  speaker: string | null
}

export function offsetCues(cues: NormalizedCue[], offsetMs: number) {
  return cues.map((cue, order) => ({ ...cue, order, startMs: cue.startMs + offsetMs, endMs: cue.endMs + offsetMs }))
}

export type PipelineRuntime = {
  prisma: PrismaClient
  storage: StorageProvider
  env: ServerEnv
  fetcher?: typeof fetch
  execute?: (command: string, args: string[]) => Promise<string>
}

type MossJob = { id: string; status: string; error?: string | null; progress?: number }

function commandOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with ${code ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

export function normalizeMossSegments(value: unknown): NormalizedCue[] {
  const source = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { segments?: unknown }).segments) ? (value as { segments: unknown[] }).segments : []
  return source.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const segment = item as Partial<MossSegment>
    const english = readString(segment.text)
    const start = readNumber(segment.start)
    const end = readNumber(segment.end)
    if (!english || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    return [{
      order: 0,
      startMs: Math.max(0, Math.round(start * 1000)),
      endMs: Math.max(1, Math.round(end * 1000)),
      english,
      speaker: readString(segment.speaker) || null,
    }]
  }).map((cue, order) => ({ ...cue, order }))
}

type TranslatableCue = { english: string; chinese?: string }

async function translateMissingCues<T extends TranslatableCue>(
  cues: T[],
  env: ServerEnv,
  fetcher: typeof fetch,
  onBatch: (input: { processedCount: number; translatedCount: number; warnings: string[] }) => Promise<void>,
) {
  const translated = cues.map((cue) => ({ ...cue, chinese: cue.chinese?.trim() ?? '' }))
  const missingIndexes = translated.flatMap((cue, index) => cue.chinese ? [] : [index])
  const warnings: string[] = []
  let translatedCount = 0
  let processedCount = 0

  for (let start = 0; start < missingIndexes.length; start += env.VOLCENGINE_TRANSLATE_BATCH_SIZE) {
    const indexes = missingIndexes.slice(start, start + env.VOLCENGINE_TRANSLATE_BATCH_SIZE)
    try {
      const chineseTexts = await translateVolcengineBatch(indexes.map((index) => translated[index].english), env, fetcher)
      indexes.forEach((index, offset) => { translated[index].chinese = chineseTexts[offset] })
      translatedCount += chineseTexts.length
    } catch (error) {
      const warning = translationWarning(error)
      if (!warnings.includes(warning)) warnings.push(warning)
      if (error instanceof TranslationError && ['DISABLED', 'INVALID_CREDENTIALS', 'INVALID_INPUT'].includes(error.code)) {
        processedCount = missingIndexes.length
        await onBatch({ processedCount, translatedCount, warnings })
        break
      }
    }
    processedCount += indexes.length
    await onBatch({ processedCount, translatedCount, warnings })
  }

  return { cues: translated, translatedCount, warnings }
}

async function mossRequest(url: string, init: RequestInit, timeoutMs: number, fetcher: typeof fetch) {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`MOSS HTTP ${response.status}: ${readString((body as Record<string, unknown>).detail) || '未知错误'}`)
  return body
}

async function transcribeWithMoss(audioPath: string, env: ServerEnv, fetcher: typeof fetch, onProgress: (progress: number) => Promise<void>) {
  const audio = await readFile(audioPath)
  const form = new FormData()
  form.set('file', new Blob([audio], { type: 'audio/wav' }), basename(audioPath))
  form.set('max_new_tokens', String(env.MOSS_MAX_NEW_TOKENS))
  form.set('max_len', String(env.MOSS_MAX_LENGTH))
  const baseUrl = env.MOSS_SERVICE_URL.replace(/\/$/, '')
  const created = await mossRequest(`${baseUrl}/api/jobs`, { method: 'POST', body: form }, env.MOSS_TIMEOUT_MS, fetcher) as MossJob
  if (!created.id) throw new Error('MOSS 未返回任务 ID')
  const startedAt = Date.now()
  while (true) {
    const current = await mossRequest(`${baseUrl}/api/jobs/${created.id}`, {}, env.MOSS_TIMEOUT_MS, fetcher) as MossJob
    if (current.status === 'waiting_review' || current.status === 'done') break
    if (current.status === 'failed' || current.status === 'cancelled') throw new Error(`MOSS ${current.status}: ${current.error ?? '未提供错误详情'}`)
    if (Date.now() - startedAt > env.MOSS_TIMEOUT_MS) throw new Error(`MOSS 转写超时（${env.MOSS_TIMEOUT_MS}ms）`)
    await onProgress(Math.max(0, Math.min(1, current.progress ?? 0)))
    await sleep(env.MOSS_POLL_MS)
  }
  const result = await mossRequest(`${baseUrl}/api/jobs/${created.id}/segments`, {}, env.MOSS_TIMEOUT_MS, fetcher)
  const cues = normalizeMossSegments(result)
  if (cues.length === 0) throw new Error('MOSS 未生成可用字幕片段')
  return cues
}

async function createAudioChunks(wavPath: string, durationSeconds: number, taskDir: string, env: ServerEnv, execute: (command: string, args: string[]) => Promise<string>) {
  const chunks: Array<{ path: string; offsetMs: number }> = []
  for (let start = 0, index = 0; start < durationSeconds; start += env.MOSS_CHUNK_SECONDS, index += 1) {
    const length = Math.min(env.MOSS_CHUNK_SECONDS, durationSeconds - start)
    const chunkPath = join(taskDir, `audio-${String(index + 1).padStart(3, '0')}.wav`)
    await execute(env.FFMPEG_PATH, ['-y', '-ss', String(start), '-t', String(length), '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', chunkPath])
    chunks.push({ path: chunkPath, offsetMs: Math.round(start * 1000) })
  }
  return chunks
}

async function updateJob(prisma: PrismaClient, id: string, input: { progress: number; stage: string; status?: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'; error?: string | null; warnings?: string[]; translatedCount?: number; totalCount?: number }) {
  await prisma.processingJob.update({
    where: { id },
    data: {
      progress: input.progress,
      ...(input.status ? { status: input.status } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      payload: {
        stage: input.stage,
        warnings: input.warnings ?? [],
        translatedCount: input.translatedCount ?? 0,
        totalCount: input.totalCount ?? 0,
      },
    },
  })
}

function buildRuntime(): PipelineRuntime {
  const env = loadServerEnv()
  return {
    prisma: new PrismaClient(),
    storage: createMinioStorageProvider({
      endpoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
    }),
    env,
  }
}

async function processTranslateOnlyJob(data: MediaQueueJob, runtime: PipelineRuntime) {
  const { prisma, env } = runtime
  const fetcher = runtime.fetcher ?? fetch
  const job = await prisma.processingJob.findUnique({
    where: { id: data.jobId },
    include: {
      upload: {
        include: {
          videoAsset: {
            include: { lesson: { include: { cues: { orderBy: { order: 'asc' } } } } },
          },
        },
      },
    },
  })
  if (!job) throw new Error(`翻译任务不存在：${data.jobId}`)
  if (job.status === 'COMPLETED') return { jobId: job.id, skipped: true }
  const lesson = job.upload.videoAsset?.lesson
  if (!lesson) throw new Error(`上传 ${job.uploadId} 缺少可补译课程`)

  const allCues = lesson.cues
  const alreadyTranslated = allCues.filter((cue) => cue.chinese.trim()).length
  const missingCues = allCues.filter((cue) => !cue.chinese.trim())
  const totalCount = allCues.length
  if (!missingCues.length) {
    await updateJob(prisma, job.id, {
      status: 'COMPLETED',
      progress: 100,
      stage: 'translation-completed',
      translatedCount: alreadyTranslated,
      totalCount,
    })
    return { jobId: job.id, translatedCount: alreadyTranslated, totalCount, warnings: [] }
  }

  try {
    await updateJob(prisma, job.id, {
      status: 'PROCESSING',
      progress: 5,
      stage: 'translation-starting',
      translatedCount: alreadyTranslated,
      totalCount,
    })
    const outcome = await translateMissingCues(missingCues, env, fetcher, async ({ processedCount, translatedCount, warnings }) => {
      await updateJob(prisma, job.id, {
        progress: 5 + Math.round((processedCount / missingCues.length) * 90),
        stage: 'translating',
        warnings,
        translatedCount: alreadyTranslated + translatedCount,
        totalCount,
      })
    })

    await prisma.$transaction(async (transaction) => {
      for (const cue of outcome.cues) {
        if (!cue.chinese) continue
        await transaction.subtitleCue.updateMany({ where: { id: cue.id, chinese: '' }, data: { chinese: cue.chinese } })
      }
      const translatedCount = await transaction.subtitleCue.count({ where: { lessonId: lesson.id, NOT: { chinese: '' } } })
      const stage = translatedCount === totalCount ? 'translation-completed' : translatedCount > alreadyTranslated ? 'translation-partial' : 'translation-unavailable'
      await transaction.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          progress: 100,
          error: null,
          payload: { stage, warnings: outcome.warnings, translatedCount, totalCount },
        },
      })
    })
    const translatedCount = alreadyTranslated + outcome.translatedCount
    return { jobId: job.id, translatedCount: Math.min(translatedCount, totalCount), totalCount, warnings: outcome.warnings }
  } catch (error) {
    const warning = translationWarning(error)
    await updateJob(prisma, job.id, {
      status: 'FAILED',
      progress: 100,
      stage: 'translation-failed',
      error: warning,
      warnings: [warning],
      translatedCount: alreadyTranslated,
      totalCount,
    })
    throw new Error('翻译任务执行失败')
  }
}

export async function processPipelineJob(data: MediaQueueJob, runtime = buildRuntime()) {
  const { prisma, storage, env } = runtime
  const execute = runtime.execute ?? commandOutput
  const fetcher = runtime.fetcher ?? fetch
  const job = await prisma.processingJob.findUnique({ include: { upload: { include: { videoAsset: true } } }, where: { id: data.jobId } })
  if (!job) throw new Error(`处理任务不存在：${data.jobId}`)
  if (job.status === 'COMPLETED') return { jobId: job.id, skipped: true }
  if (job.type === 'TRANSLATE') return processTranslateOnlyJob(data, runtime)
  if (!job.upload.videoAsset || !job.upload.videoAsset.storageKey) throw new Error(`上传 ${job.uploadId} 缺少视频资产或存储对象`)

  const taskDir = join(env.MEDIA_TMP_DIR, job.id)
  const sourcePath = join(taskDir, 'source.mp4')
  const wavPath = join(taskDir, 'audio.wav')
  const coverPath = join(taskDir, 'cover.jpg')
  const coverStorageKey = `private/covers/${job.upload.videoAsset.id}.jpg`
  const warnings: string[] = []

  try {
    await mkdir(taskDir, { recursive: true })
    await updateJob(prisma, job.id, { status: 'PROCESSING', progress: 5, stage: 'downloading' })
    await storage.download(job.upload.storageKey, sourcePath)

    await updateJob(prisma, job.id, { progress: 15, stage: 'probing' })
    const probeOutput = await execute(env.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', sourcePath])
    const durationSeconds = Number((JSON.parse(probeOutput) as { format?: { duration?: string } }).format?.duration)
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('ffprobe 未返回有效视频时长')

    await updateJob(prisma, job.id, { progress: 25, stage: 'extracting-media' })
    await execute(env.FFMPEG_PATH, ['-y', '-ss', '0', '-i', sourcePath, '-frames:v', '1', '-q:v', '2', coverPath])
    await execute(env.FFMPEG_PATH, ['-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath])
    await storage.upload(coverStorageKey, coverPath, 'image/jpeg')

    await updateJob(prisma, job.id, { progress: 40, stage: 'moss-splitting' })
    const audioChunks = await createAudioChunks(wavPath, durationSeconds, taskDir, env, execute)
    const cues: NormalizedCue[] = []
    for (const [index, chunk] of audioChunks.entries()) {
      await updateJob(prisma, job.id, { progress: 40 + Math.round((index / audioChunks.length) * 34), stage: 'moss-submitting' })
      const chunkCues = await transcribeWithMoss(chunk.path, env, fetcher, async (chunkProgress) => {
        const complete = (index + chunkProgress) / audioChunks.length
        await updateJob(prisma, job.id, { progress: 40 + Math.round(complete * 34), stage: 'moss-transcribing' })
      })
      cues.push(...offsetCues(chunkCues, chunk.offsetMs))
    }
    cues.forEach((cue, order) => { cue.order = order })
    if (cues.length === 0) throw new Error('MOSS 未生成可用字幕片段')

    await updateJob(prisma, job.id, { progress: 76, stage: 'translating', translatedCount: 0, totalCount: cues.length })
    const translation = await translateMissingCues(cues, env, fetcher, async ({ processedCount, translatedCount, warnings: translationWarnings }) => {
      await updateJob(prisma, job.id, {
        progress: 76 + Math.round((processedCount / cues.length) * 18),
        stage: 'translating',
        warnings: translationWarnings,
        translatedCount,
        totalCount: cues.length,
      })
    })
    const translated = translation.cues as Array<NormalizedCue & { chinese: string }>
    warnings.push(...translation.warnings.filter((warning) => !warnings.includes(warning)))

    await prisma.$transaction(async (transaction) => {
      const lesson = await transaction.lesson.upsert({
        where: { videoId: job.upload.videoAssetId as string },
        create: { videoId: job.upload.videoAssetId as string, title: job.upload.videoAsset?.title ?? job.upload.originalName, description: '本地 MP4 自动生成的私有学习课程' },
        update: { title: job.upload.videoAsset?.title ?? job.upload.originalName },
      })
      await transaction.subtitleCue.deleteMany({ where: { lessonId: lesson.id } })
      await transaction.subtitleCue.createMany({
        data: translated.map((cue) => ({ lessonId: lesson.id, order: cue.order, startMs: cue.startMs, endMs: cue.endMs, english: cue.english, chinese: cue.chinese, speaker: cue.speaker, keywords: [], reviewed: false })),
      })
      await transaction.videoAsset.update({
        where: { id: job.upload.videoAssetId as string },
        data: { durationMs: Math.round(durationSeconds * 1000), coverStorageKey, status: 'READY' },
      })
      await transaction.processingJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', progress: 100, error: null, payload: { stage: 'completed', warnings, translatedCount: translation.translatedCount, totalCount: cues.length } },
      })
    })
    return { jobId: job.id, cueCount: translated.length, warnings }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知媒体处理错误'
    await prisma.$transaction([
      prisma.processingJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: message, payload: { stage: 'failed', warnings }, progress: Math.min(job.progress, 99) } }),
      prisma.videoAsset.update({ where: { id: job.upload.videoAssetId as string }, data: { status: 'FAILED' } }),
    ])
    throw error
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
}
