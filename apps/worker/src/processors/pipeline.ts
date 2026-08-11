import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { PrismaClient, type Prisma } from '@prisma/client'
import { loadServerEnv, type ServerEnv } from '@online-learning/config'
import { createMinioStorageProvider, type StorageProvider } from '@online-learning/storage'
import { TranslationError, translateVolcengineBatch, translationWarning } from './volcengine-translation'
import { extractCourseVocabulary, vocabularyTranslationInput, type CourseVocabularyDraft } from './course-vocabulary'

export type MediaQueueJob = { jobId: string }
export type PipelineAttempt = { attemptsMade: number; maxAttempts: number }

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

type MossJob = {
  id: string
  status: string
  error?: string | null
  progress?: number
  usage?: { possibly_truncated?: boolean; generated_tokens?: number; max_new_tokens?: number }
}

export const MOSS_ERROR_CODES = {
  UNAVAILABLE: 'MOSS_UNAVAILABLE',
  TIMEOUT: 'MOSS_TIMEOUT',
  HTTP_ERROR: 'MOSS_HTTP_ERROR',
  INVALID_RESPONSE: 'MOSS_INVALID_RESPONSE',
  EMPTY_SEGMENTS: 'MOSS_EMPTY_SEGMENTS',
  TRUNCATED_OUTPUT: 'MOSS_TRUNCATED_OUTPUT',
} as const

export type MossErrorCode = typeof MOSS_ERROR_CODES[keyof typeof MOSS_ERROR_CODES]

export class MossError extends Error {
  readonly name = 'MossError'

  constructor(
    readonly code: MossErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

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

type VocabularyTranslationRecord = CourseVocabularyDraft & {
  id: string
  translation: string
  translationStatus: 'TRANSLATED' | 'PENDING' | 'RETRYABLE_FAILED' | 'PERMANENT_FAILED'
}

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

function vocabularyFailureState(error: unknown) {
  const translationError = error instanceof TranslationError ? error : null
  return {
    code: translationError?.code ?? 'UPSTREAM_ERROR',
    status: translationError?.retryable ? 'RETRYABLE_FAILED' as const : 'PERMANENT_FAILED' as const,
  }
}

async function ensureCourseVocabulary(prisma: PrismaClient, lessonId: string, cues: Array<{ id: string; english: string; keywords: unknown }>) {
  const drafts = extractCourseVocabulary(cues)
  await prisma.$transaction(async (transaction) => {
    for (const draft of drafts) {
      await transaction.courseVocabulary.upsert({
        where: { lessonId_normalizedWord: { lessonId, normalizedWord: draft.normalizedWord } },
        create: {
          lessonId,
          cueId: draft.sourceCueId ?? null,
          word: draft.word,
          normalizedWord: draft.normalizedWord,
          termType: draft.termType,
          sourceSentence: draft.sourceSentence,
          translation: '',
          translationSource: 'NONE',
          translationStatus: 'PENDING',
        },
        update: {
          cueId: draft.sourceCueId ?? null,
          word: draft.word,
          termType: draft.termType,
          sourceSentence: draft.sourceSentence,
        },
      })
    }

    const normalizedWords = drafts.map((draft) => draft.normalizedWord)
    if (normalizedWords.length) {
      await transaction.courseVocabulary.deleteMany({ where: { lessonId, normalizedWord: { notIn: normalizedWords } } })
    } else {
      await transaction.courseVocabulary.deleteMany({ where: { lessonId } })
    }
  })

  return prisma.courseVocabulary.findMany({ where: { lessonId }, orderBy: { id: 'asc' } }) as Promise<VocabularyTranslationRecord[]>
}

async function translateMissingVocabulary(
  prisma: PrismaClient,
  terms: VocabularyTranslationRecord[],
  env: ServerEnv,
  fetcher: typeof fetch,
  onBatch: (input: { processedCount: number; translatedCount: number; warnings: string[] }) => Promise<void>,
) {
  const translatedCount = terms.filter((term) => term.translation.trim() && term.translationStatus === 'TRANSLATED').length
  const pending = terms.filter((term) => ['PENDING', 'RETRYABLE_FAILED'].includes(term.translationStatus))
  const warnings: string[] = []
  let processedCount = 0
  let completedCount = translatedCount

  for (let start = 0; start < pending.length; start += env.VOLCENGINE_TRANSLATE_BATCH_SIZE) {
    const batch = pending.slice(start, start + env.VOLCENGINE_TRANSLATE_BATCH_SIZE)
    try {
      const translations = await translateVolcengineBatch(batch.map(vocabularyTranslationInput), env, fetcher)
      await prisma.$transaction(batch.map((term, index) => prisma.courseVocabulary.update({
        where: { id: term.id },
        data: {
          translation: translations[index],
          translationSource: 'VOLCENGINE',
          translationStatus: 'TRANSLATED',
          translationErrorCode: null,
          translatedAt: new Date(),
        },
      })))
      completedCount += translations.length
    } catch (error) {
      const warning = translationWarning(error)
      if (!warnings.includes(warning)) warnings.push(warning)
      const failure = vocabularyFailureState(error)
      await prisma.courseVocabulary.updateMany({
        where: { id: { in: batch.map((term) => term.id) } },
        data: {
          translation: '',
          translationSource: 'NONE',
          translationStatus: failure.status,
          translationErrorCode: failure.code,
          translatedAt: null,
        },
      })
      if (error instanceof TranslationError && ['DISABLED', 'INVALID_CREDENTIALS'].includes(error.code)) {
        const remaining = pending.slice(start + batch.length)
        if (remaining.length) {
          await prisma.courseVocabulary.updateMany({
            where: { id: { in: remaining.map((term) => term.id) } },
            data: {
              translation: '',
              translationSource: 'NONE',
              translationStatus: failure.status,
              translationErrorCode: failure.code,
              translatedAt: null,
            },
          })
        }
        processedCount = pending.length
        await onBatch({ processedCount, translatedCount: completedCount, warnings })
        break
      }
    }
    processedCount += batch.length
    await onBatch({ processedCount, translatedCount: completedCount, warnings })
  }

  return { translatedCount: completedCount, totalCount: terms.length, warnings }
}

function mossDetail(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const record = body as Record<string, unknown>
  return readString(record.detail) || readString(record.message)
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
}

export function classifyMossRequestError(error: unknown) {
  if (isTimeoutError(error)) return new MossError(MOSS_ERROR_CODES.TIMEOUT, 'MOSS 请求超时', true)
  if (error instanceof MossError) return error
  return new MossError(MOSS_ERROR_CODES.UNAVAILABLE, 'MOSS 服务暂时不可用，请检查服务地址和容器状态', true)
}

export async function mossRequest(
  url: string,
  init: RequestInit,
  env: ServerEnv,
  fetcher: typeof fetch,
  options: { retryableRequest?: boolean; retryNetwork?: boolean } = {},
) {
  const method = (init.method ?? 'GET').toUpperCase()
  const retryableRequest = options.retryableRequest ?? method !== 'POST'
  const maxAttempts = retryableRequest ? env.MOSS_MAX_RETRIES + 1 : 1
  let lastError: MossError | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(env.MOSS_REQUEST_TIMEOUT_MS) })
      let body: unknown = {}
      try {
        body = await response.json()
      } catch {
        if (response.ok) throw new MossError(MOSS_ERROR_CODES.INVALID_RESPONSE, 'MOSS 返回了无法解析的响应', false)
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        throw new MossError(
          MOSS_ERROR_CODES.HTTP_ERROR,
          `MOSS 请求失败（HTTP ${response.status}）：${mossDetail(body) || '未提供错误详情'}`,
          retryable,
        )
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new MossError(MOSS_ERROR_CODES.INVALID_RESPONSE, 'MOSS 返回的数据结构无效', false)
      }
      return body
    } catch (error) {
      const classified = classifyMossRequestError(error)
      const retryAllowed = classified.code === MOSS_ERROR_CODES.HTTP_ERROR || options.retryNetwork !== false
      if (!classified.retryable || !retryableRequest || !retryAllowed || attempt === maxAttempts - 1) throw classified
      lastError = classified
      await sleep(env.MOSS_RETRY_DELAY_MS * (2 ** attempt))
    }
  }
  throw lastError ?? new MossError(MOSS_ERROR_CODES.UNAVAILABLE, 'MOSS 服务暂时不可用', true)
}

function parseMossJob(value: unknown): MossJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MossError(MOSS_ERROR_CODES.INVALID_RESPONSE, 'MOSS 任务响应无效', false)
  const job = value as MossJob
  if (!job.id || !job.status) throw new MossError(MOSS_ERROR_CODES.INVALID_RESPONSE, 'MOSS 任务响应缺少 ID 或状态', false)
  return job
}

function hasSegments(value: unknown): value is { segments: unknown[] } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { segments?: unknown }).segments))
}

type MossTranscription = { cues: NormalizedCue[]; jobId: string; possiblyTruncated: boolean }

async function transcribeWithMoss(
  audioPath: string,
  env: ServerEnv,
  fetcher: typeof fetch,
  onProgress: (progress: number) => Promise<void>,
  options: { existingJobId?: string; idempotencyKey?: string; onCreated?: (jobId: string) => Promise<void> } = {},
): Promise<MossTranscription> {
  let mossJobId = options.existingJobId
  const baseUrl = env.MOSS_SERVICE_URL.replace(/\/$/, '')
  if (!mossJobId) {
    const audio = await readFile(audioPath)
    const form = new FormData()
    form.set('file', new Blob([audio], { type: 'audio/wav' }), basename(audioPath))
    form.set('max_new_tokens', String(env.MOSS_MAX_NEW_TOKENS))
    form.set('max_len', String(env.MOSS_MAX_LENGTH))
    const created = parseMossJob(await mossRequest(`${baseUrl}/api/jobs`, {
      method: 'POST',
      ...(options.idempotencyKey ? { headers: { 'x-idempotency-key': options.idempotencyKey } } : {}),
      body: form,
    }, env, fetcher, { retryableRequest: true, retryNetwork: false }))
    mossJobId = created.id
    await options.onCreated?.(mossJobId)
  }

  const startedAt = Date.now()
  let finalJob: MossJob | undefined
  while (true) {
    const current = parseMossJob(await mossRequest(`${baseUrl}/api/jobs/${mossJobId}`, {}, env, fetcher))
    if (current.status === 'waiting_review' || current.status === 'done') {
      finalJob = current
      break
    }
    if (current.status === 'failed' || current.status === 'cancelled') throw new MossError(MOSS_ERROR_CODES.HTTP_ERROR, `MOSS ${current.status}：${current.error ?? '未提供错误详情'}`, false)
    if (Date.now() - startedAt > env.MOSS_TIMEOUT_MS) throw new MossError(MOSS_ERROR_CODES.TIMEOUT, `MOSS 转写超时（${env.MOSS_TIMEOUT_MS}ms）`, true)
    await onProgress(Math.max(0, Math.min(1, current.progress ?? 0)))
    await sleep(env.MOSS_POLL_MS)
  }

  const result = await mossRequest(`${baseUrl}/api/jobs/${mossJobId}/segments`, {}, env, fetcher)
  if (!hasSegments(result)) throw new MossError(MOSS_ERROR_CODES.INVALID_RESPONSE, 'MOSS 字幕响应缺少 segments 数组', false)
  const cues = normalizeMossSegments(result)
  const possiblyTruncated = finalJob?.usage?.possibly_truncated === true
  if (cues.length === 0) {
    throw new MossError(
      possiblyTruncated ? MOSS_ERROR_CODES.TRUNCATED_OUTPUT : MOSS_ERROR_CODES.EMPTY_SEGMENTS,
      possiblyTruncated ? 'MOSS 输出达到 token 上限且没有可用字幕片段' : 'MOSS 未生成可用字幕片段',
      false,
    )
  }
  return { cues, jobId: mossJobId, possiblyTruncated }
}

type AudioChunk = { key: string; path: string; offsetMs: number; durationSeconds: number }

async function createAudioChunks(
  wavPath: string,
  durationSeconds: number,
  taskDir: string,
  chunkSeconds: number,
  ffmpegPath: string,
  execute: (command: string, args: string[]) => Promise<string>,
  filenamePrefix = 'audio',
) {
  const chunks: AudioChunk[] = []
  for (let start = 0, index = 0; start < durationSeconds; start += chunkSeconds, index += 1) {
    const length = Math.min(chunkSeconds, durationSeconds - start)
    const key = `${filenamePrefix}-${String(index + 1).padStart(3, '0')}`
    const chunkPath = join(taskDir, `${key}.wav`)
    await execute(ffmpegPath, ['-y', '-ss', String(start), '-t', String(length), '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', chunkPath])
    chunks.push({ key, path: chunkPath, offsetMs: Math.round(start * 1000), durationSeconds: length })
  }
  return chunks
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
}

function payloadNumber(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function payloadWarnings(record: Record<string, unknown>) {
  return Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === 'string') : []
}

function mossJobMap(record: Record<string, unknown>) {
  const value = record.mossJobs
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, jobId]) => typeof jobId === 'string' && jobId.length > 0))
}

async function rememberMossJob(prisma: PrismaClient, id: string, chunkKey: string, mossJobId: string) {
  const current = await prisma.processingJob.findUnique({ where: { id }, select: { payload: true } })
  const record = payloadRecord(current?.payload)
  const nextPayload = { ...record, mossJobs: { ...mossJobMap(record), [chunkKey]: mossJobId } }
  await prisma.processingJob.update({ where: { id }, data: { payload: nextPayload as Prisma.InputJsonObject } })
}

async function updateJob(prisma: PrismaClient, id: string, input: {
  progress: number
  stage: string
  status?: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  error?: string | null
  errorCode?: string | null
  warnings?: string[]
  translatedCount?: number
  totalCount?: number
  vocabularyTranslatedCount?: number
  vocabularyTotalCount?: number
}) {
  const current = await prisma.processingJob.findUnique({ where: { id }, select: { payload: true } })
  const previous = payloadRecord(current?.payload)
  const nextPayload: Record<string, unknown> = {
    ...previous,
    stage: input.stage,
    warnings: input.warnings ?? payloadWarnings(previous),
    translatedCount: input.translatedCount ?? payloadNumber(previous, 'translatedCount'),
    totalCount: input.totalCount ?? payloadNumber(previous, 'totalCount'),
    vocabularyTranslatedCount: input.vocabularyTranslatedCount ?? payloadNumber(previous, 'vocabularyTranslatedCount'),
    vocabularyTotalCount: input.vocabularyTotalCount ?? payloadNumber(previous, 'vocabularyTotalCount'),
  }
  if (input.errorCode !== undefined) {
    if (input.errorCode === null) delete nextPayload.errorCode
    else nextPayload.errorCode = input.errorCode
  }
  await prisma.processingJob.update({
    where: { id },
    data: {
      progress: input.progress,
      ...(input.status ? { status: input.status } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      payload: nextPayload as Prisma.InputJsonObject,
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
  const vocabulary = await ensureCourseVocabulary(prisma, lesson.id, allCues)
  const alreadyTranslated = allCues.filter((cue) => cue.chinese.trim()).length
  const missingCues = allCues.filter((cue) => !cue.chinese.trim())
  const totalCount = allCues.length
  const vocabularyTranslatedCount = vocabulary.filter((term) => term.translation.trim() && term.translationStatus === 'TRANSLATED').length
  const vocabularyPending = vocabulary.some((term) => !term.translation.trim() && ['PENDING', 'RETRYABLE_FAILED'].includes(term.translationStatus))
  if (!missingCues.length && !vocabularyPending) {
    const stage = vocabularyTranslatedCount === vocabulary.length ? 'translation-completed' : vocabularyTranslatedCount > 0 ? 'translation-partial' : 'translation-unavailable'
    await updateJob(prisma, job.id, {
      status: 'COMPLETED',
      progress: 100,
      stage,
      translatedCount: alreadyTranslated,
      totalCount,
      vocabularyTranslatedCount,
      vocabularyTotalCount: vocabulary.length,
    })
    return { jobId: job.id, translatedCount: alreadyTranslated, totalCount, vocabularyTranslatedCount, vocabularyTotalCount: vocabulary.length, warnings: [] }
  }

  try {
    await updateJob(prisma, job.id, {
      status: 'PROCESSING',
      progress: 5,
      stage: 'translation-starting',
      translatedCount: alreadyTranslated,
      totalCount,
      vocabularyTranslatedCount,
      vocabularyTotalCount: vocabulary.length,
    })
    const subtitleOutcome = await translateMissingCues(missingCues, env, fetcher, async ({ processedCount, translatedCount, warnings }) => {
      await updateJob(prisma, job.id, {
        progress: 5 + Math.round((processedCount / Math.max(missingCues.length, 1)) * 58),
        stage: 'translating',
        warnings,
        translatedCount: alreadyTranslated + translatedCount,
        totalCount,
        vocabularyTranslatedCount,
        vocabularyTotalCount: vocabulary.length,
      })
    })

    await prisma.$transaction(async (transaction) => {
      for (const cue of subtitleOutcome.cues) {
        if (!cue.chinese) continue
        await transaction.subtitleCue.updateMany({ where: { id: cue.id, chinese: '' }, data: { chinese: cue.chinese } })
      }
    })

    const pendingVocabulary = vocabulary.filter((term) => ['PENDING', 'RETRYABLE_FAILED'].includes(term.translationStatus))
    const vocabularyOutcome = await translateMissingVocabulary(prisma, vocabulary, env, fetcher, async ({ processedCount, translatedCount, warnings }) => {
      await updateJob(prisma, job.id, {
        progress: 63 + Math.round((processedCount / Math.max(pendingVocabulary.length, 1)) * 32),
        stage: 'translating-vocabulary',
        warnings: [...subtitleOutcome.warnings, ...warnings.filter((warning) => !subtitleOutcome.warnings.includes(warning))],
        translatedCount: alreadyTranslated + subtitleOutcome.translatedCount,
        totalCount,
        vocabularyTranslatedCount: translatedCount,
        vocabularyTotalCount: vocabulary.length,
      })
    })
    const translatedCount = await prisma.subtitleCue.count({ where: { lessonId: lesson.id, NOT: { chinese: '' } } })
    const stage = translatedCount === totalCount && vocabularyOutcome.translatedCount === vocabularyOutcome.totalCount
      ? 'translation-completed'
      : translatedCount > 0 || vocabularyOutcome.translatedCount > 0 ? 'translation-partial' : 'translation-unavailable'
    const warnings = [...subtitleOutcome.warnings, ...vocabularyOutcome.warnings.filter((warning) => !subtitleOutcome.warnings.includes(warning))]
    await updateJob(prisma, job.id, {
      status: 'COMPLETED',
      progress: 100,
      error: null,
      errorCode: null,
      stage,
      warnings,
      translatedCount,
      totalCount,
      vocabularyTranslatedCount: vocabularyOutcome.translatedCount,
      vocabularyTotalCount: vocabularyOutcome.totalCount,
    })
    return { jobId: job.id, translatedCount, totalCount, vocabularyTranslatedCount: vocabularyOutcome.translatedCount, vocabularyTotalCount: vocabularyOutcome.totalCount, warnings }
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
      vocabularyTranslatedCount,
      vocabularyTotalCount: vocabulary.length,
    })
    throw new Error('翻译任务执行失败')
  }
}

export async function processPipelineJob(data: MediaQueueJob, runtime = buildRuntime(), attempt: PipelineAttempt = { attemptsMade: 0, maxAttempts: 1 }) {
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
  const mossJobs = mossJobMap(payloadRecord(job.payload)) as Record<string, string>

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
    const audioChunks = await createAudioChunks(wavPath, durationSeconds, taskDir, env.MOSS_CHUNK_SECONDS, env.FFMPEG_PATH, execute)
    const cues: NormalizedCue[] = []
    const outputRecoveryCodes: MossErrorCode[] = [MOSS_ERROR_CODES.EMPTY_SEGMENTS, MOSS_ERROR_CODES.TRUNCATED_OUTPUT]
    const transcribeChunk = (chunk: AudioChunk, position: number, total: number, stage: string) => transcribeWithMoss(
      chunk.path,
      env,
      fetcher,
      async (chunkProgress) => {
        const complete = (position + chunkProgress) / total
        await updateJob(prisma, job.id, { progress: 40 + Math.round(complete * 34), stage })
      },
      {
        existingJobId: mossJobs[chunk.key],
        idempotencyKey: `${job.id}:${chunk.key}`,
        onCreated: async (mossJobId) => {
          mossJobs[chunk.key] = mossJobId
          await rememberMossJob(prisma, job.id, chunk.key, mossJobId)
        },
      },
    )

    for (const [index, chunk] of audioChunks.entries()) {
      await updateJob(prisma, job.id, { progress: 40 + Math.round((index / audioChunks.length) * 34), stage: 'moss-submitting' })
      let primary: MossTranscription | undefined
      let primaryError: MossError | undefined
      try {
        primary = await transcribeChunk(chunk, index, audioChunks.length, 'moss-transcribing')
      } catch (error) {
        if (!(error instanceof MossError) || !outputRecoveryCodes.includes(error.code)) throw error
        primaryError = error
      }

      if (primary && !primary.possiblyTruncated) {
        cues.push(...offsetCues(primary.cues, chunk.offsetMs))
        continue
      }

      const recoverySeconds = Math.min(env.MOSS_RECOVERY_CHUNK_SECONDS, Math.max(5, Math.floor(chunk.durationSeconds / 2)))
      const recoveryChunks = await createAudioChunks(chunk.path, chunk.durationSeconds, taskDir, recoverySeconds, env.FFMPEG_PATH, execute, `${chunk.key}-recovery`)
      const recovered: NormalizedCue[] = []
      for (const [recoveryIndex, recoveryChunk] of recoveryChunks.entries()) {
        try {
          const recovery = await transcribeChunk(
            recoveryChunk,
            index + (recoveryIndex / recoveryChunks.length),
            audioChunks.length,
            'moss-recovery',
          )
          recovered.push(...offsetCues(recovery.cues, recoveryChunk.offsetMs))
        } catch (error) {
          if (error instanceof MossError && outputRecoveryCodes.includes(error.code)) continue
          throw error
        }
      }

      if (recovered.length > 0) {
        cues.push(...offsetCues(recovered, chunk.offsetMs))
        warnings.push(`${primaryError?.code ?? MOSS_ERROR_CODES.TRUNCATED_OUTPUT}: 音频片段 ${index + 1} 已通过短片段恢复`)
      } else if (primary?.cues.length) {
        cues.push(...offsetCues(primary.cues, chunk.offsetMs))
        warnings.push(`${MOSS_ERROR_CODES.TRUNCATED_OUTPUT}: 音频片段 ${index + 1} 使用了未完整输出`)
      } else {
        warnings.push(`${primaryError?.code ?? MOSS_ERROR_CODES.TRUNCATED_OUTPUT}: 音频片段 ${index + 1} 未生成可用字幕，已跳过`)
      }
    }
    cues.forEach((cue, order) => { cue.order = order })
    if (cues.length === 0) throw new MossError(MOSS_ERROR_CODES.EMPTY_SEGMENTS, 'MOSS 未生成可用字幕片段', false)

    await updateJob(prisma, job.id, { progress: 76, stage: 'translating' })
    const translated = [] as Array<NormalizedCue & { chinese: string }>
    for (const cue of cues) {
      let chinese = ''
      try {
        chinese = (await translateVolcengineBatch([cue.english], env, fetcher))[0] ?? ''
      } catch (error) {
        const message = translationWarning(error)
        if (!warnings.includes(message)) warnings.push(message)
      }
      translated.push({ ...cue, chinese })
      await updateJob(prisma, job.id, { progress: 76 + Math.round((translated.length / cues.length) * 18), stage: 'translating', warnings })
    }

    await prisma.$transaction(async (transaction) => {
      const lesson = await transaction.lesson.upsert({
        where: { videoId: job.upload.videoAssetId as string },
        create: { videoId: job.upload.videoAssetId as string, title: job.upload.videoAsset?.title ?? job.upload.originalName, description: '本地 MP4 自动生成的私有学习课程' },
        update: { title: job.upload.videoAsset?.title ?? job.upload.originalName },
      })
      await transaction.courseVocabulary.deleteMany({ where: { lessonId: lesson.id } })
      await transaction.subtitleCue.deleteMany({ where: { lessonId: lesson.id } })
      await transaction.subtitleCue.createMany({
        data: translated.map((cue) => ({ lessonId: lesson.id, order: cue.order, startMs: cue.startMs, endMs: cue.endMs, english: cue.english, chinese: cue.chinese, speaker: cue.speaker, keywords: [], reviewed: false })),
      })
      const persistedCues = await transaction.subtitleCue.findMany({ where: { lessonId: lesson.id }, orderBy: { order: 'asc' }, select: { id: true, english: true, keywords: true } })
      const drafts = extractCourseVocabulary(persistedCues)
      if (drafts.length) {
        await transaction.courseVocabulary.createMany({
          data: drafts.map((draft) => ({
            lessonId: lesson.id,
            cueId: draft.sourceCueId ?? null,
            word: draft.word,
            normalizedWord: draft.normalizedWord,
            termType: draft.termType,
            sourceSentence: draft.sourceSentence,
            translation: '',
            translationSource: 'NONE',
            translationStatus: 'PENDING',
          })),
        })
      }
      await transaction.videoAsset.update({
        where: { id: job.upload.videoAssetId as string },
        data: { durationMs: Math.round(durationSeconds * 1000), coverStorageKey, status: 'READY' },
      })
    })
    const lesson = await prisma.lesson.findUnique({ where: { videoId: job.upload.videoAssetId as string }, select: { id: true } })
    const vocabulary = lesson ? await prisma.courseVocabulary.findMany({ where: { lessonId: lesson.id }, orderBy: { id: 'asc' } }) as VocabularyTranslationRecord[] : []
    const vocabularyOutcome = await translateMissingVocabulary(prisma, vocabulary, env, fetcher, async ({ processedCount, translatedCount, warnings: vocabularyWarnings }) => {
      const allWarnings = [...warnings, ...vocabularyWarnings.filter((warning) => !warnings.includes(warning))]
      await updateJob(prisma, job.id, {
        progress: 86 + Math.round((processedCount / Math.max(vocabulary.length, 1)) * 12),
        stage: 'translating-vocabulary',
        warnings: allWarnings,
        translatedCount: translated.filter((cue) => cue.chinese.trim()).length,
        totalCount: translated.length,
        vocabularyTranslatedCount: translatedCount,
        vocabularyTotalCount: vocabulary.length,
      })
    })
    warnings.push(...vocabularyOutcome.warnings.filter((warning) => !warnings.includes(warning)))
    const subtitleTranslatedCount = translated.filter((cue) => cue.chinese.trim()).length
    const stage = subtitleTranslatedCount === translated.length && vocabularyOutcome.translatedCount === vocabularyOutcome.totalCount
      ? 'completed'
      : subtitleTranslatedCount > 0 || vocabularyOutcome.translatedCount > 0 ? 'translation-partial' : 'translation-unavailable'
    await updateJob(prisma, job.id, {
      status: 'COMPLETED',
      progress: 100,
      error: null,
      errorCode: null,
      stage,
      warnings,
      translatedCount: subtitleTranslatedCount,
      totalCount: translated.length,
      vocabularyTranslatedCount: vocabularyOutcome.translatedCount,
      vocabularyTotalCount: vocabularyOutcome.totalCount,
    })
    return { jobId: job.id, cueCount: translated.length, translatedCount: subtitleTranslatedCount, totalCount: translated.length, vocabularyTranslatedCount: vocabularyOutcome.translatedCount, vocabularyTotalCount: vocabularyOutcome.totalCount, warnings }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知媒体处理错误'
    const latest = await prisma.processingJob.findUnique({ where: { id: job.id }, select: { progress: true, payload: true } })
    const previous = payloadRecord(latest?.payload)
    const currentProgress = Math.min(Math.max(latest?.progress ?? job.progress, 0), 99)
    const currentStage = typeof previous.stage === 'string' && previous.stage.length > 0 ? previous.stage : 'failed'
    const errorCode = error instanceof MossError ? error.code : 'PIPELINE_FAILED'
    const mergedWarnings = [...payloadWarnings(previous), ...warnings.filter((warning) => !payloadWarnings(previous).includes(warning))]
    const canRetry = error instanceof MossError && error.retryable && attempt.attemptsMade + 1 < attempt.maxAttempts
    if (canRetry) {
      await updateJob(prisma, job.id, {
        status: 'QUEUED',
        progress: currentProgress,
        stage: 'waiting-dependency',
        error: message,
        errorCode,
        warnings: mergedWarnings,
      })
      throw error
    }
    await updateJob(prisma, job.id, {
      status: 'FAILED',
      progress: currentProgress,
      stage: currentStage,
      error: message,
      errorCode,
      warnings: mergedWarnings,
    })
    await prisma.videoAsset.update({ where: { id: job.upload.videoAssetId as string }, data: { status: 'FAILED' } })
    throw error
  } finally {
    await rm(taskDir, { recursive: true, force: true })
  }
}
