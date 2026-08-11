import { z } from 'zod'

export const IdSchema = z.string().min(1)
export const JobStatusSchema = z.enum(['queued', 'processing', 'review', 'completed', 'failed'])
export const JobTypeSchema = z.enum(['transcode', 'transcribe', 'translate', 'segment', 'publish'])
export const LessonLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1'])

export const SubtitleCueSchema = z.object({
  id: IdSchema,
  order: z.number().int().nonnegative().default(0),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  english: z.string().min(1),
  chinese: z.string().default(''),
  speaker: z.string().nullable().optional(),
  keywords: z.array(z.string()).default([]),
  reviewed: z.boolean().default(false),
})

export const VideoSummarySchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  subtitle: z.string().default(''),
  creator: z.string().min(1),
  level: LessonLevelSchema,
  category: z.string(),
  accent: z.string(),
  durationSeconds: z.number().int().positive(),
  coverUrl: z.string().url(),
  published: z.boolean(),
})

export const LessonDetailSchema = VideoSummarySchema.extend({
  description: z.string().default(''),
  playbackUrl: z.string().url().nullable(),
  cues: z.array(SubtitleCueSchema),
})

export const PhoneRequestCodeSchema = z.object({ phone: z.string().regex(/^1\d{10}$/) })
export const PhoneVerifyCodeSchema = PhoneRequestCodeSchema.extend({ code: z.string().regex(/^\d{6}$/) })
export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({ id: IdSchema, phone: z.string(), displayName: z.string() }),
})

export const VideoQuerySchema = z.object({
  search: z.string().optional(),
  level: LessonLevelSchema.optional(),
  category: z.string().optional(),
  accent: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

export const ProgressUpdateSchema = z.object({
  lessonId: IdSchema,
  currentCueId: IdSchema.optional(),
  completedCueIds: z.array(IdSchema),
  positionMs: z.number().int().nonnegative(),
})

export const UploadRequestSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.string().startsWith('video/'),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  rightsConfirmed: z.literal(true),
  title: z.string().trim().min(1).max(180),
  category: z.string().trim().min(1).max(60),
  accent: z.string().trim().min(1).max(60),
  level: LessonLevelSchema,
})

export const ProcessingJobSchema = z.object({
  id: IdSchema,
  uploadId: IdSchema,
  type: JobTypeSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  stage: z.string().default('queued'),
  warnings: z.array(z.string()).default([]),
  translatedCount: z.number().int().nonnegative().default(0),
  totalCount: z.number().int().nonnegative().default(0),
  vocabularyTranslatedCount: z.number().int().nonnegative().default(0),
  vocabularyTotalCount: z.number().int().nonnegative().default(0),
  error: z.string().nullable(),
  errorCode: z.string().nullable().default(null),
  updatedAt: z.string().datetime(),
})

export const TranslationCoverageSchema = z.object({
  translatedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  status: z.enum(['not_started', 'processing', 'completed', 'partial', 'unavailable', 'failed']),
  warnings: z.array(z.string()),
})

export const VocabularyTranslationSourceSchema = z.enum(['VOLCENGINE', 'LOCAL_FALLBACK', 'NONE'])
export const VocabularyTranslationStatusSchema = z.enum(['TRANSLATED', 'PENDING', 'RETRYABLE_FAILED', 'PERMANENT_FAILED'])
export const VocabularyTermTypeSchema = z.enum(['WORD', 'PHRASE'])

export const CourseVocabularySchema = z.object({
  id: IdSchema,
  lessonId: IdSchema,
  sourceCueId: IdSchema.nullable(),
  word: z.string().min(1),
  normalizedWord: z.string().min(1),
  termType: VocabularyTermTypeSchema,
  sourceSentence: z.string().min(1),
  translation: z.string().default(''),
  translationSource: VocabularyTranslationSourceSchema,
  translationStatus: VocabularyTranslationStatusSchema,
  translationErrorCode: z.string().nullable(),
  translatedAt: z.string().datetime().nullable(),
})

export const TranslateCourseResponseSchema = z.object({
  job: ProcessingJobSchema.nullable(),
  coverage: TranslationCoverageSchema,
  vocabularyCoverage: TranslationCoverageSchema,
  queued: z.boolean(),
})

export const UploadTargetSchema = z.object({
  uploadId: IdSchema,
  assetId: IdSchema,
  storageKey: z.string().min(1),
  putUrl: z.string().url(),
  expiresAt: z.string().datetime(),
})

export const UploadCompletionSchema = z.object({
  uploadId: IdSchema,
  job: ProcessingJobSchema,
})

export const PrivateCourseSummarySchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  creator: z.string().min(1),
  coverUrl: z.string().url().nullable(),
  durationSeconds: z.number().nonnegative(),
  status: z.enum(['ready', 'processing', 'failed']),
  cueCount: z.number().int().nonnegative(),
  chineseCueCount: z.number().int().nonnegative(),
  vocabularyCount: z.number().int().nonnegative(),
  translatedVocabularyCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
})

export const PrivateLessonDetailSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  creator: z.string().min(1),
  coverUrl: z.string().url().nullable(),
  playbackUrl: z.string().url(),
  durationSeconds: z.number().nonnegative(),
  cues: z.array(SubtitleCueSchema),
  vocabulary: z.array(CourseVocabularySchema),
  warnings: z.array(z.string()),
  translation: TranslationCoverageSchema,
  vocabularyTranslation: TranslationCoverageSchema,
})

export const AdminReviewSchema = z.object({
  status: z.enum(['approved', 'rejected', 'changes_requested']),
  note: z.string().max(1000).default(''),
})

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
})

export type SubtitleCue = z.infer<typeof SubtitleCueSchema>
export type VideoSummary = z.infer<typeof VideoSummarySchema>
export type LessonDetail = z.infer<typeof LessonDetailSchema>
export type ProcessingJob = z.infer<typeof ProcessingJobSchema>
export type TranslationCoverage = z.infer<typeof TranslationCoverageSchema>
export type CourseVocabulary = z.infer<typeof CourseVocabularySchema>
export type TranslateCourseResponse = z.infer<typeof TranslateCourseResponseSchema>
export type VideoQuery = z.infer<typeof VideoQuerySchema>
export type ProgressUpdate = z.infer<typeof ProgressUpdateSchema>
export type UploadRequest = z.infer<typeof UploadRequestSchema>
export type UploadTarget = z.infer<typeof UploadTargetSchema>
export type UploadCompletion = z.infer<typeof UploadCompletionSchema>
export type PrivateCourseSummary = z.infer<typeof PrivateCourseSummarySchema>
export type PrivateLessonDetail = z.infer<typeof PrivateLessonDetailSchema>
