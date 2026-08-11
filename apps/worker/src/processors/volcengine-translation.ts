import { createHash, createHmac } from 'node:crypto'
import type { ServerEnv } from '@online-learning/config'

export type TranslationFailureCode = 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'NETWORK_TIMEOUT' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE' | 'INVALID_INPUT' | 'DISABLED'

export class TranslationError extends Error {
  constructor(public readonly code: TranslationFailureCode, message: string, public readonly retryable: boolean) {
    super(message)
    this.name = 'TranslationError'
  }
}

function formatDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function readTranslation(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  for (const field of ['Translation', 'TranslationText', 'translation']) {
    const result = row[field]
    if (typeof result === 'string' && result.trim()) return result.trim()
  }
  return ''
}

function responseError(status: number) {
  if (status === 401 || status === 403) return new TranslationError('INVALID_CREDENTIALS', 'translation credentials are invalid', false)
  if (status === 429) return new TranslationError('RATE_LIMITED', 'translation rate limited', true)
  if (status >= 500) return new TranslationError('UPSTREAM_ERROR', 'translation service unavailable', true)
  return new TranslationError('INVALID_RESPONSE', `translation request failed (HTTP ${status})`, false)
}

function metadataError(code: unknown) {
  if (typeof code !== 'string' || !code) return null
  const normalizedCode = code.toLowerCase()
  if (code.includes('429') || normalizedCode.includes('throttle')) return new TranslationError('RATE_LIMITED', 'translation rate limited', true)
  if (normalizedCode.includes('signature') || normalizedCode.includes('credential') || normalizedCode.includes('accessdenied') || normalizedCode.includes('authorization')) return new TranslationError('INVALID_CREDENTIALS', 'translation credentials are invalid', false)
  if (normalizedCode.includes('internal') || normalizedCode.includes('service')) return new TranslationError('UPSTREAM_ERROR', 'translation service unavailable', true)
  return new TranslationError('INVALID_RESPONSE', 'translation response was invalid', false)
}

function networkError(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return new TranslationError('NETWORK_TIMEOUT', 'translation request timed out', true)
  return new TranslationError('UPSTREAM_ERROR', 'translation service could not be reached', true)
}

export function translationWarning(error: unknown) {
  if (error instanceof TranslationError) return `${error.code}: ${error.message}`
  return 'UPSTREAM_ERROR: translation failed with an unknown error'
}

async function translateBatchOnce(texts: string[], env: ServerEnv, fetcher: typeof fetch) {
  if (env.VOLCENGINE_TRANSLATE !== 'true') throw new TranslationError('DISABLED', 'translation is disabled', false)
  const accessKey = env.VOLCENGINE_ACCESS_KEY_ID?.trim()
  const secretKey = env.VOLCENGINE_SECRET_ACCESS_KEY?.trim()
  if (!accessKey || !secretKey) throw new TranslationError('INVALID_CREDENTIALS', 'translation credentials are not configured', false)
  if (!texts.length || texts.some((text) => !text.trim())) throw new TranslationError('INVALID_INPUT', 'translation input cannot be empty', false)

  const endpoint = new URL(env.VOLCENGINE_TRANSLATE_ENDPOINT)
  endpoint.search = 'Action=TranslateText&Version=2025-03-01'
  const payload = JSON.stringify({ SourceLanguage: 'en', TargetLanguage: 'zh', TextList: texts })
  const now = new Date()
  const amzDate = formatDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const service = 'translate'
  const payloadHash = sha256(payload)
  const canonicalHeaders = `host:${endpoint.host}\nx-content-sha256:${payloadHash}\nx-date:${amzDate}`
  const signedHeaders = 'host;x-content-sha256;x-date'
  const canonicalRequest = `POST\n${endpoint.pathname || '/'}\n${endpoint.search.slice(1)}\n${canonicalHeaders}\n\n${signedHeaders}\n${payloadHash}`
  const credentialScope = `${dateStamp}/${env.VOLCENGINE_REGION}/${service}/request`
  const stringToSign = `HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`
  const signingKey = hmac(hmac(hmac(hmac(secretKey, dateStamp), env.VOLCENGINE_REGION), service), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  let response: Response
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: endpoint.host,
        'x-content-sha256': payloadHash,
        'x-date': amzDate,
        authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: payload,
      signal: AbortSignal.timeout(env.VOLCENGINE_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError(error)
  }

  const result = await response.json().catch(() => null) as { ResponseMetadata?: { Error?: { Code?: unknown } }; Result?: { TranslationList?: unknown }; TranslationList?: unknown } | null
  const upstreamError = metadataError(result?.ResponseMetadata?.Error?.Code)
  if (upstreamError) throw upstreamError
  if (!response.ok) throw responseError(response.status)
  const translationList = result?.Result?.TranslationList ?? result?.TranslationList
  if (!Array.isArray(translationList) || translationList.length !== texts.length) {
    throw new TranslationError('INVALID_RESPONSE', 'translation response count did not match the input batch', false)
  }
  const translations = translationList.map(readTranslation)
  if (translations.some((translation) => !translation)) throw new TranslationError('INVALID_RESPONSE', 'translation response contained an empty result', false)
  return translations
}

export async function translateVolcengineBatch(texts: string[], env: ServerEnv, fetcher: typeof fetch) {
  let lastError: unknown
  for (let attempt = 0; attempt <= env.VOLCENGINE_TRANSLATE_MAX_RETRIES; attempt += 1) {
    try {
      return await translateBatchOnce(texts, env, fetcher)
    } catch (error) {
      lastError = error
      if (!(error instanceof TranslationError) || !error.retryable || attempt === env.VOLCENGINE_TRANSLATE_MAX_RETRIES) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, env.VOLCENGINE_TRANSLATE_RETRY_DELAY_MS * (2 ** attempt)))
    }
  }
  throw lastError
}
