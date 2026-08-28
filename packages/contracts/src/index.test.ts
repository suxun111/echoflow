import { describe, expect, it } from 'vitest'
import {
  AccessSessionSchema, ApiErrorSchema, CreateUploadSchema, DEFAULT_UPLOAD_PART_SIZE_BYTES,
  MAX_UPLOAD_BYTES, MediaAssetStatusSchema, OtpRequestSchema, ProcessingStageSchema,
  ProcessingStatusSchema, SignUploadPartsSchema, TranscriptStatusSchema,
  TranscriptCueViewSchema,
} from './index'

describe('G1 contracts', () => {
  it('requires E.164 phones and rejects extra fields', () => {
    expect(OtpRequestSchema.parse({ phone: '+8613800000000' })).toEqual({ phone: '+8613800000000' })
    expect(() => OtpRequestSchema.parse({ phone: '13800000000' })).toThrow()
    expect(() => OtpRequestSchema.parse({ phone: '+8613800000000', ownerId: 'spoofed' })).toThrow()
  })

  it('never includes a refresh token in the access-session response', () => {
    expect(() => AccessSessionSchema.parse({
      accessToken: 'access', expiresInSeconds: 600, refreshToken: 'forbidden',
      user: { id: crypto.randomUUID(), phone: '+8613800000000', displayName: 'Learner', role: 'learner', status: 'active' },
    })).toThrow()
  })

  it('requires a stable error code and requestId', () => {
    expect(ApiErrorSchema.parse({ code: 'unauthenticated', message: 'unauthorized', requestId: 'request-123' }).code).toBe('unauthenticated')
    expect(() => ApiErrorSchema.parse({ code: 'made_up', message: 'bad', requestId: 'request-123' })).toThrow()
  })

  it('freezes the PRD media, processing and transcript states', () => {
    expect(MediaAssetStatusSchema.options).toEqual(['processing_playback', 'playable', 'failed', 'deleting', 'deleted'])
    expect(ProcessingStatusSchema.options).toEqual(['queued', 'processing', 'validating', 'succeeded', 'failed', 'cancelled'])
    expect(ProcessingStageSchema.options).toEqual([
      'upload_verified', 'probing', 'playback_ready', 'audio_extracting', 'chunking', 'transcribing',
      'handoff_evidencing', 'merging', 'cue_segmenting', 'validating', 'transcript_ready', 'course_ready',
    ])
    expect(TranscriptStatusSchema.options).toEqual(['building', 'active', 'superseded', 'rejected'])
  })

  it('freezes the G2 MP4, 8 GiB and multipart boundaries', () => {
    const valid = {
      fileName: 'two-hour-podcast.mp4', contentType: 'video/mp4' as const,
      sizeBytes: MAX_UPLOAD_BYTES, fileFingerprint: 'a'.repeat(64), rightsConfirmed: true as const,
    }
    expect(CreateUploadSchema.parse(valid).sizeBytes).toBe(MAX_UPLOAD_BYTES)
    expect(DEFAULT_UPLOAD_PART_SIZE_BYTES).toBe(33_554_432)
    expect(Math.ceil(MAX_UPLOAD_BYTES / DEFAULT_UPLOAD_PART_SIZE_BYTES)).toBe(256)
    expect(() => CreateUploadSchema.parse({ ...valid, sizeBytes: MAX_UPLOAD_BYTES + 1 })).toThrow()
    expect(() => CreateUploadSchema.parse({ ...valid, fileName: 'podcast.mov' })).toThrow()
    expect(() => SignUploadPartsSchema.parse({ partNumbers: [1, 1] })).toThrow()
  })

  it('allows a segment-timed cue without fabricated word timings', () => {
    expect(TranscriptCueViewSchema.parse({
      id: crypto.randomUUID(), order: 0, startMs: 250, endMs: 1_750,
      text: 'Hello from MOSS.', words: [],
    }).words).toEqual([])
  })
})
