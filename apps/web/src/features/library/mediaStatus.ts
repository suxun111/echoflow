import type { MediaAssetView } from '@online-learning/contracts'
import { MAX_UPLOAD_DURATION_MS } from '../../lib/mediaLimits'

export type TranscriptTone = 'waiting' | 'processing' | 'checking' | 'failed'

export type TranscriptStatusCopy = {
  tone: TranscriptTone
  label: string
  detail: string
  canCheck: boolean
  retryable: boolean
}

const stageCopy: Record<string, string> = {
  playback_ready: '正在准备英文字幕',
  audio_extracting: '正在准备视频音频',
  chunking: '正在整理长视频',
  transcribing: '正在生成英文字幕',
  merging: '正在整理完整字幕',
  cue_segmenting: '正在整理句子',
  validating: '正在核验字幕完整性',
  transcript_ready: '正在确认完整英文字幕',
}

const retryableErrorCodes = new Set([
  'audio_extract_failed',
  'moss_unavailable',
  'moss_timeout',
  'moss_rate_limited',
  'transcript_publish_failed',
])

function failureDetail(errorCode: string | null) {
  if (errorCode === 'media_duration_unsupported') return '该视频超过当前 60 分钟上限，原片仍可播放。'
  if (errorCode === 'audio_extract_failed') return '无法准备视频音频，原片仍可播放。'
  if (errorCode === 'transcript_incomplete') {
    return '字幕完整性核验未通过，未发布任何部分字幕。'
  }
  if (retryableErrorCodes.has(errorCode ?? '')) return '字幕处理暂未完成，原片仍可播放，可稍后重试。'
  return '字幕处理未完成，原片仍可播放。'
}

export function formatMediaDuration(durationMs: number | null) {
  if (!durationMs) return '等待播放检查'
  const minutes = Math.round(durationMs / 60_000)
  if (minutes < 1) return '不足 1 分钟'
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
}

export function formatCueTimestamp(positionMs: number) {
  const minutes = Math.floor(positionMs / 60_000)
  const seconds = String(Math.floor(positionMs / 1_000) % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export function describeTranscript(asset: MediaAssetView): TranscriptStatusCopy {
  const state = asset.transcriptProcessing

  if (state?.status === 'succeeded') {
    return {
      tone: 'checking',
      label: '等待字幕确认',
      detail: '处理已结束；打开后会确认完整英文字幕是否可用。',
      canCheck: true,
      retryable: false,
    }
  }

  if (asset.durationMs === null) {
    return {
      tone: 'failed',
      label: '字幕不支持',
      detail: '无法确认视频时长，不能生成或重试字幕。',
      canCheck: false,
      retryable: false,
    }
  }

  if (asset.durationMs > MAX_UPLOAD_DURATION_MS || state?.errorCode === 'media_duration_unsupported') {
    return {
      tone: 'failed',
      label: '字幕不支持',
      detail: '该视频超过当前 60 分钟上限，原片仍可播放。',
      canCheck: false,
      retryable: false,
    }
  }

  if (!state) {
    return {
      tone: 'waiting',
      label: '等待英文字幕',
      detail: '原片可播放，完整英文字幕尚未开始处理。',
      canCheck: false,
      retryable: false,
    }
  }

  if (state.status === 'failed' || state.status === 'cancelled') {
    return {
      tone: 'failed',
      label: '字幕生成失败',
      detail: failureDetail(state.errorCode),
      canCheck: false,
      retryable: retryableErrorCodes.has(state.errorCode ?? ''),
    }
  }

  return {
    tone: 'processing',
    label: '正在生成英文字幕',
    detail: stageCopy[state.stage ?? ''] ?? '正在处理英文字幕。',
    canCheck: false,
    retryable: false,
  }
}
