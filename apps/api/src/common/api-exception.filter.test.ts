import type { ArgumentsHost } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { ApiExceptionFilter } from './api-exception.filter'

function filterResponse(exception: unknown) {
  let status = 0
  let body: unknown
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId: 'filter-request-id' }),
      getResponse: () => ({
        status(code: number) {
          status = code
          return this
        },
        json(value: unknown) {
          body = value
        },
      }),
    }),
  } as ArgumentsHost

  new ApiExceptionFilter().catch(exception, host)
  return { status, body }
}

describe('ApiExceptionFilter', () => {
  it('normalizes serializable transaction conflicts as stable 409 responses', () => {
    const response = filterResponse(Object.assign(new Error('transaction conflict'), { code: 'P2034' }))
    expect(response).toEqual({
      status: 409,
      body: { code: 'conflict', message: '并发请求发生冲突，请重试', requestId: 'filter-request-id' },
    })
  })

  it('does not expose unknown failures and keeps their requestId', () => {
    const response = filterResponse(new Error('database password leaked here'))
    expect(response).toEqual({
      status: 500,
      body: { code: 'internal_error', message: '服务器内部错误', requestId: 'filter-request-id' },
    })
  })
})
