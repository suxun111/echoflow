import { Inject, Injectable } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { ApiException } from '../../common/api-exception'
import { SERVER_ENV } from '../../config/app-config.module'

export const OTP_DELIVERY = Symbol('OTP_DELIVERY')

export type OtpDeliveryRequest = {
  phone: string
  code: string
  expiresAt: Date
}

export interface OtpDeliveryPort {
  deliver(request: OtpDeliveryRequest): Promise<{ developmentCode?: string }>
}

@Injectable()
export class ExplicitTestOtpDelivery implements OtpDeliveryPort {
  constructor(@Inject(SERVER_ENV) private readonly env: ServerEnv) {}

  async deliver(request: OtpDeliveryRequest) {
    if (this.env.NODE_ENV !== 'production' && this.env.AUTH_EXPOSE_TEST_OTP) {
      return { developmentCode: request.code }
    }
    throw new ApiException(503, 'service_unavailable', 'OTP 发送通道尚未配置')
  }
}
