import { describe, expect, it, vi } from 'vitest'
import { ServerEnvSchema } from '@online-learning/config'
import { TranslationError, translateVolcengineBatch } from './volcengine-translation'

function translationEnv(overrides: Record<string, string> = {}) {
  return ServerEnvSchema.parse({
    VOLCENGINE_TRANSLATE: 'true',
    VOLCENGINE_ACCESS_KEY_ID: 'access-key',
    VOLCENGINE_SECRET_ACCESS_KEY: 'secret-key',
    VOLCENGINE_TRANSLATE_BATCH_SIZE: '20',
    VOLCENGINE_TRANSLATE_MAX_RETRIES: '1',
    VOLCENGINE_TRANSLATE_RETRY_DELAY_MS: '1',
    ...overrides,
  })
}

describe('Volcengine translation adapter', () => {
  it('reads the official nested Result.TranslationList response shape', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).search).toBe('?Action=TranslateText&Version=2025-03-01')
      return new Response(JSON.stringify({ Result: { TranslationList: [{ Translation: 'hello in Chinese' }] } }), { status: 200 })
    })
    await expect(translateVolcengineBatch(['Hello.'], translationEnv(), fetcher)).resolves.toEqual(['hello in Chinese'])
  })

  it('classifies an HTTP 200 metadata error without exposing the upstream body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch' } } }), { status: 200 }))
    await expect(translateVolcengineBatch(['Hello.'], translationEnv(), fetcher)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('classifies an HTTP 400 invalid authorization response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'InvalidAuthorization' } } }), { status: 400 }))
    await expect(translateVolcengineBatch(['Hello.'], translationEnv(), fetcher)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('maps a batch response in the same order as the input cues', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { TextList: string[] }
      expect(body.TextList).toEqual(['Hello.', 'Good morning.'])
      expect(String((init?.headers as Record<string, string>).authorization)).toContain('SignedHeaders=host;x-content-sha256;x-date')
      return new Response(JSON.stringify({ TranslationList: [{ Translation: '你好。' }, { Translation: '早上好。' }] }), { status: 200 })
    })

    await expect(translateVolcengineBatch(['Hello.', 'Good morning.'], translationEnv(), fetcher)).resolves.toEqual(['你好。', '早上好。'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not call upstream when translation is disabled', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(translateVolcengineBatch(['Hello.'], translationEnv({ VOLCENGINE_TRANSLATE: 'false' }), fetcher)).rejects.toMatchObject({ code: 'DISABLED' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retries rate limits once, then returns a stable failure code', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 429 }))
    const error = await translateVolcengineBatch(['Hello.'], translationEnv(), fetcher).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(TranslationError)
    expect((error as TranslationError).code).toBe('RATE_LIMITED')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects an upstream result whose translation count does not match the batch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ TranslationList: [{ Translation: '你好。' }] }), { status: 200 }))
    await expect(translateVolcengineBatch(['Hello.', 'Good morning.'], translationEnv(), fetcher)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
