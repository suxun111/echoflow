import { z } from 'zod'

export const IdSchema = z.string().uuid()
export const PhoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, '手机号必须使用 E.164 格式')
export const UserRoleSchema = z.enum(['learner', 'admin'])
export const UserStatusSchema = z.enum(['active', 'disabled', 'deleted'])

export const UploadStatusSchema = z.enum(['created', 'uploading', 'verifying', 'completed', 'cancelled', 'expired', 'failed'])
export const MediaAssetStatusSchema = z.enum(['processing_playback', 'playable', 'failed', 'deleting', 'deleted'])
export const ProcessingStatusSchema = z.enum(['queued', 'processing', 'validating', 'succeeded', 'failed', 'cancelled'])
export const ProcessingStageSchema = z.enum([
  'upload_verified', 'probing', 'playback_ready', 'audio_extracting', 'chunking', 'transcribing',
  'merging', 'cue_segmenting', 'validating', 'transcript_ready', 'course_ready',
])
export const TranscriptStatusSchema = z.enum(['building', 'active', 'superseded', 'rejected'])
export const LessonStatusSchema = z.enum(['processing', 'ready', 'archived'])

export const AuthUserSchema = z.object({
  id: IdSchema,
  phone: PhoneSchema,
  displayName: z.string().min(1).max(120),
  role: UserRoleSchema,
  status: UserStatusSchema,
})

export const OtpRequestSchema = z.object({ phone: PhoneSchema }).strict()
export const OtpRequestResponseSchema = z.object({
  accepted: z.literal(true),
  expiresInSeconds: z.number().int().positive(),
  developmentCode: z.string().regex(/^\d{6}$/).optional(),
})
export const OtpVerifySchema = OtpRequestSchema.extend({ code: z.string().regex(/^\d{6}$/) }).strict()
export const AccessSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  user: AuthUserSchema,
}).strict()

export const ApiErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'unprocessable_entity',
  'rate_limited',
  'internal_error',
  'service_unavailable',
])
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
  requestId: z.string().min(1),
})

export const PrivateLessonSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(300),
  status: LessonStatusSchema,
  mediaAssetId: IdSchema,
  transcriptVersionId: IdSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

// Legacy prototype contracts remain temporarily so Web/Worker continue to compile.
// They are not mounted as V1 API routes and will be removed in their owning Gates.
export const JobStatusSchema = z.enum(['queued', 'processing', 'review', 'completed', 'failed'])
export const JobTypeSchema = z.enum(['transcode', 'transcribe', 'translate', 'segment', 'publish'])
export const LessonLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1'])
export const SubtitleCueSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  english: z.string().min(1),
  chinese: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  reviewed: z.boolean().default(false),
})
export const VideoSummarySchema = z.object({
  id: z.string().min(1), title: z.string().min(1), subtitle: z.string().default(''), creator: z.string().min(1),
  level: LessonLevelSchema, category: z.string(), accent: z.string(), durationSeconds: z.number().int().positive(),
  coverUrl: z.string().url(), published: z.boolean(),
})
export const LessonDetailSchema = VideoSummarySchema.extend({ description: z.string().default(''), playbackUrl: z.string().url().nullable(), cues: z.array(SubtitleCueSchema) })
export const PhoneRequestCodeSchema = OtpRequestSchema
export const PhoneVerifyCodeSchema = OtpVerifySchema
export const AuthSessionSchema = AccessSessionSchema
export const VideoQuerySchema = z.object({
  search: z.string().optional(), level: LessonLevelSchema.optional(), category: z.string().optional(), accent: z.string().optional(),
  page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
export const ProgressUpdateSchema = z.object({
  lessonId: z.string().min(1), currentCueId: z.string().min(1).optional(), completedCueIds: z.array(z.string().min(1)), positionMs: z.number().int().nonnegative(),
})
export const UploadRequestSchema = z.object({
  fileName: z.string().min(1), contentType: z.literal('video/mp4'), sizeBytes: z.number().int().positive().max(8 * 1024 * 1024 * 1024), rightsConfirmed: z.literal(true),
})
export const ProcessingJobSchema = z.object({
  id: z.string().min(1), uploadId: z.string().min(1), type: JobTypeSchema, status: JobStatusSchema,
  progress: z.number().min(0).max(100), error: z.string().nullable(), updatedAt: z.string().datetime(),
})
export const AdminReviewSchema = z.object({ status: z.enum(['approved', 'rejected', 'changes_requested']), note: z.string().max(1000).default('') })

export type AuthUser = z.infer<typeof AuthUserSchema>
export type AccessSession = z.infer<typeof AccessSessionSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>
export type PrivateLesson = z.infer<typeof PrivateLessonSchema>
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>
export type VideoSummary = z.infer<typeof VideoSummarySchema>
export type LessonDetail = z.infer<typeof LessonDetailSchema>
export type ProcessingJob = z.infer<typeof ProcessingJobSchema>
export type VideoQuery = z.infer<typeof VideoQuerySchema>
export type ProgressUpdate = z.infer<typeof ProgressUpdateSchema>
export type UploadRequest = z.infer<typeof UploadRequestSchema>
