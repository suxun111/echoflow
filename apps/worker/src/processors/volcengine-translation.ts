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
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
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

function readTranslationList(value: unknown) {
  if (!value || typeof value !== 'object') return []
  const response = value as Record<string, unknown>
  const result = response.Result
  if (result && typeof result === 'object') {
    const nestedList = (result as Record<string, unknown>).TranslationList
    if (Array.isArray(nestedList)) return nestedList
  }
  return Array.isArray(response.TranslationList) ? response.TranslationList : []
}

function readResponseError(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const metadata = (value as Record<string, unknown>).ResponseMetadata
  if (!metadata || typeof metadata !== 'object') return null
  const error = (metadata as Record<string, unknown>).Error
  if (!error || typeof error !== 'object') return null
  const code = String((error as Record<string, unknown>).Code ?? 'UPSTREAM_ERROR')
  if (/signature|credential|access.?denied|unauthorized/i.test(code)) {
    return new TranslationError('INVALID_CREDENTIALS', `Volcengine authentication rejected (${code})`, false)
  }
  if (/429|rate.?limit|throttl/i.test(code)) return new TranslationError('RATE_LIMITED', `Volcengine request was rate limited (${code})`, true)
  if (/internal|unavailable|timeout|upstream/i.test(code)) return new TranslationError('UPSTREAM_ERROR', `Volcengine service error (${code})`, true)
  return new TranslationError('INVALID_RESPONSE', `Volcengine API error (${code})`, false)
}

function responseError(status: number) {
  if (status === 401 || status === 403) return new TranslationError('INVALID_CREDENTIALS', '火山翻译凭据无效或没有权限', false)
  if (status === 429) return new TranslationError('RATE_LIMITED', '火山翻译请求受限', true)
  if (status >= 500) return new TranslationError('UPSTREAM_ERROR', '火山翻译服务暂不可用', true)
  return new TranslationError('INVALID_RESPONSE', `火山翻译请求失败（HTTP ${status}）`, false)
}

function networkError(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return new TranslationError('NETWORK_TIMEOUT', '火山翻译请求超时', true)
  return new TranslationError('UPSTREAM_ERROR', '无法连接火山翻译服务', true)
}

export function translationWarning(error: unknown) {
  if (error instanceof TranslationError) return `${error.code}: ${error.message}`
  return 'UPSTREAM_ERROR: 火山翻译出现未知错误'
}

async function translateBatchOnce(texts: string[], env: ServerEnv, fetcher: typeof fetch) {
  if (env.VOLCENGINE_TRANSLATE !== 'true') throw new TranslationError('DISABLED', '火山翻译未启用', false)
  const accessKey = env.VOLCENGINE_ACCESS_KEY_ID?.trim()
  const secretKey = env.VOLCENGINE_SECRET_ACCESS_KEY?.trim()
  if (!accessKey || !secretKey) throw new TranslationError('INVALID_CREDENTIALS', '火山翻译凭据未配置', false)
  if (!texts.length || texts.some((text) => !text.trim())) throw new TranslationError('INVALID_INPUT', '待翻译英文字幕不能为空', false)

  const endpoint = new URL(env.VOLCENGINE_TRANSLATE_ENDPOINT)
  endpoint.search = 'Action=TranslateText&Version=2020-06-01'
  const payload = JSON.stringify({ SourceLanguage: 'en', TargetLanguage: 'zh', TextList: texts })
  const now = new Date()
  const amzDate = formatDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const service = 'translate'
  const payloadHash = sha256(payload)
  const canonicalHeaders = `host:${endpoint.host}\nx-content-sha256:${payloadHash}\nx-date:${amzDate}\n`
  const signedHeaders = 'host;x-content-sha256;x-date'
  const canonicalRequest = `POST\n${endpoint.pathname || '/'}\n${endpoint.search.slice(1)}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
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

  if (!response.ok) throw responseError(response.status)
  const result = await response.json().catch(() => null)
  const apiError = readResponseError(result)
  if (apiError) throw apiError
  const translationList = readTranslationList(result)
  if (translationList.length !== texts.length) {
    throw new TranslationError('INVALID_RESPONSE', '火山翻译响应数量与字幕数量不匹配', false)
  }
  const translations = translationList.map(readTranslation)
  if (translations.some((translation) => !translation)) throw new TranslationError('INVALID_RESPONSE', '火山翻译响应缺少中文结果', false)
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
