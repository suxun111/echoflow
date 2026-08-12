import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import type { AuthenticatedUser } from '../modules/auth/auth.types'

type HeaderValue = string | string[] | undefined

export type RequestContext = {
  method: string
  path?: string
  originalUrl?: string
  ip?: string
  headers: Record<string, HeaderValue>
  requestId?: string
  user?: AuthenticatedUser
}

type ResponseContext = {
  statusCode: number
  setHeader(name: string, value: string): void
  on(event: 'finish', listener: () => void): void
}

type Next = (error?: unknown) => void

const RequestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/

export function installRequestContext(app: INestApplication, logRequests: boolean) {
  app.use((request: RequestContext, response: ResponseContext, next: Next) => {
    const incoming = request.headers['x-request-id']
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming
    const requestId = candidate && RequestIdPattern.test(candidate) ? candidate : randomUUID()
    const startedAt = performance.now()
    request.requestId = requestId
    response.setHeader('x-request-id', requestId)

    if (logRequests) {
      response.on('finish', () => {
        const path = request.path ?? request.originalUrl?.split('?')[0] ?? 'unknown'
        console.log(JSON.stringify({
          type: 'http_request', requestId, method: request.method, path,
          status: response.statusCode, durationMs: Math.round(performance.now() - startedAt),
        }))
      })
    }
    next()
  })
}
