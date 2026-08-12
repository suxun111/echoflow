import { describe, expect, it } from 'vitest'
import {
  AccessSessionSchema, ApiErrorSchema, MediaAssetStatusSchema, OtpRequestSchema,
  ProcessingStageSchema, ProcessingStatusSchema, TranscriptStatusSchema,
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
      'merging', 'cue_segmenting', 'validating', 'transcript_ready', 'course_ready',
    ])
    expect(TranscriptStatusSchema.options).toEqual(['building', 'active', 'superseded', 'rejected'])
  })
})
