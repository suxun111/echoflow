import { HttpException } from '@nestjs/common'
import type { ApiError } from '@online-learning/contracts'

export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly apiCode: ApiError['code'],
    message: string,
    readonly details?: unknown,
  ) {
    super({ code: apiCode, message, ...(details === undefined ? {} : { details }) }, status)
  }
}
