import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common'
import { ZodError } from 'zod'

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void }; getHeader(name: string): string | undefined }>()
    const request = host.switchToHttp().getRequest<{ method: string; url: string; requestId?: string }>()
    const requestId = request.requestId ?? response.getHeader('x-request-id')
    let status = 500
    let code = 'INTERNAL_ERROR'
    let message = '服务器内部错误'
    let details: unknown

    if (exception instanceof ZodError) {
      status = 400
      code = 'VALIDATION_ERROR'
      message = '请求参数校验失败'
      details = exception.flatten()
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      code = `HTTP_${status}`
      const payload = exception.getResponse()
      if (typeof payload === 'string') message = payload
      else if (payload && typeof payload === 'object' && 'message' in payload) message = Array.isArray(payload.message) ? payload.message.join('; ') : String(payload.message)
      if (payload && typeof payload === 'object' && 'details' in payload) details = payload.details
    }

    console.error(JSON.stringify({ level: 'error', requestId, method: request.method, url: request.url, status, code, error: exception instanceof Error ? exception.message : String(exception) }))
    response.status(status).json({ code, message, ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) })
  }
}
