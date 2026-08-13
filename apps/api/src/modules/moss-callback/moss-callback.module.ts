import { Body, Controller, Headers, Inject, Module, Post, Req } from '@nestjs/common'
import type { ServerEnv } from '@online-learning/config'
import { MossCallbackSchema } from '@online-learning/contracts'
import { Prisma } from '@online-learning/database'
import { ApiException } from '../../common/api-exception'
import { Public } from '../../common/auth.decorators'
import { SERVER_ENV } from '../../config/app-config.module'
import { DatabaseService } from '../../database/database.module'
import { MossSignatureError, verifyMossCallbackSignature } from './signature'

function header(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

@Controller('integrations/moss')
export class MossCallbackController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  @Public()
  @Post('callback')
  async callback(
    @Req() request: { rawBody?: Buffer },
    @Body() input: unknown,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!this.env.MOSS_ENABLED || !this.env.MOSS_CALLBACK_SECRET) {
      throw new ApiException(503, 'service_unavailable', 'MOSS callback is not enabled')
    }
    let verified: ReturnType<typeof verifyMossCallbackSignature>
    try {
      verified = verifyMossCallbackSignature({
        eventId: header(headers['x-echoflow-event-id']),
        timestamp: header(headers['x-echoflow-timestamp']),
        nonce: header(headers['x-echoflow-nonce']),
        signature: header(headers['x-echoflow-signature']),
        rawBody: request.rawBody,
      }, this.env.MOSS_CALLBACK_SECRET, this.env.MOSS_CALLBACK_MAX_AGE_SECONDS)
    } catch (error) {
      if (error instanceof MossSignatureError) throw new ApiException(401, 'moss_callback_invalid', 'MOSS callback signature is invalid')
      throw error
    }
    const body = MossCallbackSchema.parse(input)

    return this.database.$transaction(async (transaction) => {
      const existingEvent = await transaction.mossCallbackReceipt.findUnique({ where: { eventId: verified.eventId } })
      if (existingEvent) {
        if (existingEvent.nonce !== verified.nonce || existingEvent.payloadHash !== verified.payloadHash) {
          throw new ApiException(409, 'moss_callback_invalid', 'MOSS callback event identity conflicts')
        }
        return { accepted: true, duplicate: true }
      }
      const existingNonce = await transaction.mossCallbackReceipt.findUnique({ where: { nonce: verified.nonce } })
      if (existingNonce) throw new ApiException(409, 'moss_callback_invalid', 'MOSS callback nonce was already used')

      const chunk = await transaction.processingChunk.findFirst({
        where: { externalJobId: body.externalJobId, idempotencyKey: body.idempotencyKey },
        include: { processingRun: { select: { id: true, mediaAssetId: true, status: true } } },
      })
      await transaction.mossCallbackReceipt.create({
        data: {
          eventId: verified.eventId,
          nonce: verified.nonce,
          processingChunkId: chunk?.id,
          externalJobId: body.externalJobId,
          idempotencyKey: body.idempotencyKey,
          payloadHash: verified.payloadHash,
          externalStatus: body.status,
          occurredAt: new Date(body.occurredAt),
          processedAt: new Date(),
        },
      })
      if (!chunk || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(chunk.status)
        || ['FAILED', 'CANCELLED'].includes(chunk.processingRun.status)) {
        return { accepted: true, duplicate: false }
      }

      let changed: { count: number }
      if (body.status === 'failed' || body.status === 'cancelled') {
        changed = await transaction.processingChunk.updateMany({
          where: {
            id: chunk.id, status: { in: ['QUEUED', 'PROCESSING'] },
            OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lte: new Date(body.occurredAt) } }],
          },
          data: {
            status: 'FAILED', errorCode: body.errorCode ?? 'moss_rejected', failedAt: new Date(),
            nextPollAt: null, leaseOwner: null, leaseExpiresAt: null, externalUpdatedAt: new Date(body.occurredAt),
          },
        })
      } else {
        changed = await transaction.processingChunk.updateMany({
          where: {
            id: chunk.id, status: { in: ['QUEUED', 'PROCESSING'] },
            OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lte: new Date(body.occurredAt) } }],
          },
          data: { status: 'PROCESSING', nextPollAt: new Date(), externalUpdatedAt: new Date(body.occurredAt) },
        })
      }
      if (changed.count === 0) return { accepted: true, duplicate: false, ignored: true }
      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'ProcessingChunk', aggregateId: chunk.id,
          eventType: 'moss.callback_received', idempotencyKey: `moss-callback:${verified.eventId}`,
          payload: {
            mediaAssetId: chunk.processingRun.mediaAssetId,
            processingRunId: chunk.processingRun.id,
            processingChunkId: chunk.id,
          },
        },
      })
      return { accepted: true, duplicate: false }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 15_000 })
  }
}

@Module({ controllers: [MossCallbackController] })
export class MossCallbackModule {}
