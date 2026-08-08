import { z } from 'zod'

export const IdSchema = z.string().min(1)
export const JobStatusSchema = z.enum(['queued', 'processing', 'waiting_dependency', 'review', 'completed', 'failed'])
export const JobTypeSchema = z.enum(['transcode', 'transcribe', 'translate', 'segment', 'publish'])
export const LessonLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1'])

export const SubtitleCueSchema = z.object({
  id: IdSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  english: z.string().min(1),
  chinese: z.string().default(''),
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
  fileName: z.string().min(1).max(255).refine((value) => !(/[\\/\0]/.test(value)), '文件名不能包含路径或控制字符'),
  contentType: z.enum(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  rightsConfirmed: z.literal(true),
})

export const ProcessingJobSchema = z.object({
  id: IdSchema,
  uploadId: IdSchema,
  type: JobTypeSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  stage: z.string().nullable().optional(),
  error: z.string().nullable(),
  errorCode: z.string().nullable().optional(),
  attempts: z.number().int().nonnegative().optional(),
  lastAttemptAt: z.string().datetime().nullable().optional(),
  failedAt: z.string().datetime().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  updatedAt: z.string().datetime(),
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
export type VideoQuery = z.infer<typeof VideoQuerySchema>
export type ProgressUpdate = z.infer<typeof ProgressUpdateSchema>
export type UploadRequest = z.infer<typeof UploadRequestSchema>
