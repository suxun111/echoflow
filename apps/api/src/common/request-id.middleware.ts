import { randomUUID } from 'node:crypto'

export class RequestIdMiddleware {
  use(request: { headers: Record<string, string | string[] | undefined>; requestId?: string; method?: string; originalUrl?: string }, response: { setHeader(name: string, value: string): void; statusCode?: number; on?(event: string, listener: () => void): void }, next: () => void) {
    const incoming = request.headers['x-request-id']
    const requestId = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID()
    request.requestId = requestId
    response.setHeader('x-request-id', requestId)
    const startedAt = Date.now()
    response.on?.('finish', () => console.log(JSON.stringify({ level: 'info', event: 'http_request', requestId, method: request.method, url: request.originalUrl, status: response.statusCode, durationMs: Date.now() - startedAt })))
    next()
  }
}
