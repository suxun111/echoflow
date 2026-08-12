import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'
import type { ApiError } from '@online-learning/contracts'
import type { ZodIssue } from 'zod'
import { ApiException } from './api-exception'
import type { RequestContext } from './request-context'

type ErrorResponse = {
  status(code: number): ErrorResponse
  json(body: ApiError): void
}

type PrismaLikeError = Error & { code?: string; meta?: unknown }
type ZodLikeError = Error & { issues: ZodIssue[] }

function isZodError(exception: unknown): exception is ZodLikeError {
  return exception instanceof Error && exception.name === 'ZodError' && Array.isArray((exception as ZodLikeError).issues)
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp()
    const request = http.getRequest<RequestContext>()
    const response = http.getResponse<ErrorResponse>()
    const normalized = this.normalize(exception)

    response.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      requestId: request.requestId ?? 'request-id-unavailable',
    })
  }

  private normalize(exception: unknown): { status: number; code: ApiError['code']; message: string; details?: unknown } {
    if (exception instanceof ApiException) {
      return { status: exception.getStatus(), code: exception.apiCode, message: exception.message, details: exception.details }
    }
    if (isZodError(exception)) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'invalid_request',
        message: '请求参数无效',
        details: exception.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      }
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const code = this.codeForStatus(status)
      const body = exception.getResponse()
      const message = typeof body === 'string'
        ? body
        : typeof body === 'object' && body && 'message' in body
          ? String((body as { message: unknown }).message)
          : exception.message
      return { status, code, message }
    }
    const prismaError = exception as PrismaLikeError
    if (prismaError?.code === 'P2002') return { status: 409, code: 'conflict', message: '资源已存在或请求发生冲突' }
    if (prismaError?.code === 'P2003') return { status: 409, code: 'conflict', message: '关联资源状态冲突' }
    if (prismaError?.code === 'P2023') return { status: 400, code: 'invalid_request', message: '资源标识格式无效' }
    if (prismaError?.code === 'P2034') return { status: 409, code: 'conflict', message: '并发请求发生冲突，请重试' }
    if (prismaError?.code === 'P2025') return { status: 404, code: 'not_found', message: '资源不存在' }
    return { status: 500, code: 'internal_error', message: '服务器内部错误' }
  }

  private codeForStatus(status: number): ApiError['code'] {
    if (status === 400) return 'invalid_request'
    if (status === 401) return 'unauthenticated'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not_found'
    if (status === 409) return 'conflict'
    if (status === 422) return 'unprocessable_entity'
    if (status === 429) return 'rate_limited'
    if (status === 503) return 'service_unavailable'
    return 'internal_error'
  }
}
