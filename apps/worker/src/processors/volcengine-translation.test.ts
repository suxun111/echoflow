import { describe, expect, it, vi } from 'vitest'
import { loadServerEnv } from '@online-learning/config'
import { TranslationError, translateVolcengineBatch } from './volcengine-translation'

function enabledEnv() {
  return loadServerEnv({
    VOLCENGINE_TRANSLATE: 'true',
    VOLCENGINE_ACCESS_KEY_ID: 'test-access-key',
    VOLCENGINE_SECRET_ACCESS_KEY: 'test-secret-key',
    VOLCENGINE_TRANSLATE_MAX_RETRIES: '1',
    VOLCENGINE_TRANSLATE_RETRY_DELAY_MS: '1',
  })
}

describe('Volcengine translation client', () => {
  it('maps one translation response to each source item', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ TranslationList: [{ Translation: '欢迎' }, { Translation: '海滨小镇' }] }), { status: 200 }))
    const result = await translateVolcengineBatch(['Welcome', 'coastal town'], enabledEnv(), fetcher)
    expect(result).toEqual(['欢迎', '海滨小镇'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('accepts the official nested response envelope', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ResponseMetadata: {}, Result: { TranslationList: [{ Translation: 'translated' }] } }), { status: 200 }))
    await expect(translateVolcengineBatch(['hello'], enabledEnv(), fetcher)).resolves.toEqual(['translated'])
  })

  it('classifies an API error returned with HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch' } } }), { status: 200 }))
    await expect(translateVolcengineBatch(['hello'], enabledEnv(), fetcher)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', retryable: false })
  })

  it('retries a timeout and exposes a real failure when credentials are rejected', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ TranslationList: [{ Translation: '你好' }] }), { status: 200 }))
    await expect(translateVolcengineBatch(['hello'], enabledEnv(), fetcher)).resolves.toEqual(['你好'])
    expect(fetcher).toHaveBeenCalledTimes(2)

    const rejected = vi.fn<typeof fetch>(async () => new Response('', { status: 401 }))
    await expect(translateVolcengineBatch(['hello'], enabledEnv(), rejected)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', retryable: false })
  })
})
