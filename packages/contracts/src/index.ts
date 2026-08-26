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
  'upload_active_conflict',
  'upload_expired',
  'upload_part_invalid',
  'upload_manifest_incomplete',
  'upload_object_mismatch',
  'media_format_unsupported',
  'media_duration_unsupported',
  'media_not_playable',
  'storage_unavailable',
  'transcript_not_ready',
  'transcript_active_conflict',
  'audio_extract_failed',
  'audio_chunk_failed',
  'moss_unavailable',
  'moss_timeout',
  'moss_rate_limited',
  'moss_rejected',
  'moss_invalid_response',
  'moss_callback_invalid',
  'transcript_incomplete',
  'transcript_timing_invalid',
  'transcript_publish_failed',
  'transcript_pipeline_conflict',
  'enrollment_not_allowlisted',
  'enrollment_rejected',
  'processing_cancelled',
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

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
export const MAX_UPLOAD_DURATION_MS = 60 * 60 * 1000
export const DEFAULT_UPLOAD_PART_SIZE_BYTES = 32 * 1024 * 1024

export const CreateUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(512).refine((value) => value.toLowerCase().endsWith('.mp4'), '只支持 MP4 文件'),
  contentType: z.literal('video/mp4'),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  fileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rightsConfirmed: z.literal(true),
  title: z.string().trim().min(1).max(300).optional(),
}).strict()

export const UploadPartSchema = z.object({
  partNumber: z.number().int().positive().max(10_000),
  sizeBytes: z.number().int().positive(),
  etag: z.string().trim().min(1).max(512),
}).strict()

export const SignUploadPartsSchema = z.object({
  partNumbers: z.array(z.number().int().positive().max(10_000)).min(1).max(20)
    .refine((values) => new Set(values).size === values.length, '分片编号不能重复'),
}).strict()

export const UploadPartViewSchema = UploadPartSchema.extend({ completedAt: z.string().datetime() })

export const UploadSessionViewSchema = z.object({
  id: IdSchema,
  status: UploadStatusSchema,
  originalName: z.string(),
  title: z.string(),
  contentType: z.literal('video/mp4'),
  sizeBytes: z.number().int().positive(),
  fileFingerprint: z.string().nullable(),
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  uploadedBytes: z.number().int().nonnegative(),
  parts: z.array(UploadPartViewSchema),
  mediaAssetId: IdSchema.nullable(),
}).strict()

export const SignedUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  uploadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
}).strict()

export const SignedUploadPartsResponseSchema = z.object({ parts: z.array(SignedUploadPartSchema) }).strict()

export const TranscriptProcessingViewSchema = z.object({
  status: ProcessingStatusSchema.nullable(),
  stage: ProcessingStageSchema.nullable(),
  completedChunks: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict()

export const MediaAssetViewSchema = z.object({
  id: IdSchema,
  uploadSessionId: IdSchema.nullable(),
  title: z.string(),
  originalName: z.string(),
  status: MediaAssetStatusSchema,
  durationMs: z.number().int().positive().nullable(),
  processingStage: ProcessingStageSchema.nullable(),
  errorCode: z.string().nullable(),
  transcriptProcessing: TranscriptProcessingViewSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export const PlaybackUrlSchema = z.object({
  mediaAssetId: IdSchema,
  playbackUrl: z.string().url(),
  expiresAt: z.string().datetime(),
}).strict()

export const TranscriptWordSchema = z.object({
  text: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).strict().refine((word) => word.endMs > word.startMs, '单词结束时间必须晚于开始时间')

export const TranscriptCueViewSchema = z.object({
  id: IdSchema,
  order: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1),
  words: z.array(TranscriptWordSchema),
}).strict()

export const ActiveTranscriptViewSchema = z.object({
  id: IdSchema,
  mediaAssetId: IdSchema,
  version: z.number().int().positive(),
  language: z.literal('en'),
  durationMs: z.number().int().positive(),
  cueCount: z.number().int().nonnegative(),
  pipelineVersion: z.string().min(1),
  modelVersion: z.string().min(1),
  publishedAt: z.string().datetime(),
  cues: z.array(TranscriptCueViewSchema),
}).strict()

export const MossCallbackStatusSchema = z.enum(['queued', 'processing', 'succeeded', 'failed', 'cancelled'])
export const MossCallbackSchema = z.object({
  externalJobId: z.string().min(1).max(512),
  idempotencyKey: z.string().min(1).max(512),
  status: MossCallbackStatusSchema,
  occurredAt: z.string().datetime(),
  errorCode: z.string().min(1).max(128).optional(),
}).strict()

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
export const UploadRequestSchema = CreateUploadSchema
export const ProcessingJobSchema = z.object({
  id: z.string().min(1), uploadId: z.string().min(1), type: JobTypeSchema, status: JobStatusSchema,
  progress: z.number().min(0).max(100), error: z.string().nullable(), updatedAt: z.string().datetime(),
})
export const AdminReviewSchema = z.object({ status: z.enum(['approved', 'rejected', 'changes_requested']), note: z.string().max(1000).default('') })

export type AuthUser = z.infer<typeof AuthUserSchema>
export type AccessSession = z.infer<typeof AccessSessionSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>
export type PrivateLesson = z.infer<typeof PrivateLessonSchema>
export type CreateUpload = z.infer<typeof CreateUploadSchema>
export type UploadPart = z.infer<typeof UploadPartSchema>
export type UploadPartView = z.infer<typeof UploadPartViewSchema>
export type SignUploadParts = z.infer<typeof SignUploadPartsSchema>
export type UploadSessionView = z.infer<typeof UploadSessionViewSchema>
export type MediaAssetView = z.infer<typeof MediaAssetViewSchema>
export type PlaybackUrl = z.infer<typeof PlaybackUrlSchema>
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>
export type TranscriptCueView = z.infer<typeof TranscriptCueViewSchema>
export type ActiveTranscriptView = z.infer<typeof ActiveTranscriptViewSchema>
export type TranscriptProcessingView = z.infer<typeof TranscriptProcessingViewSchema>
export type MossCallback = z.infer<typeof MossCallbackSchema>
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>
export type VideoSummary = z.infer<typeof VideoSummarySchema>
export type LessonDetail = z.infer<typeof LessonDetailSchema>
export type ProcessingJob = z.infer<typeof ProcessingJobSchema>
export type VideoQuery = z.infer<typeof VideoQuerySchema>
export type ProgressUpdate = z.infer<typeof ProgressUpdateSchema>
export type UploadRequest = z.infer<typeof UploadRequestSchema>
