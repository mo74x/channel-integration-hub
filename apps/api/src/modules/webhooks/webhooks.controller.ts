import {
  Controller,
  Post,
  Param,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
  UnprocessableEntityException,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiSecurity,
  ApiBody,
} from '@nestjs/swagger';
import { Request } from 'express';
import { createHash } from 'node:crypto';
import { prisma } from '@cih/database';
import { CanonicalReservationSchema } from '@cih/shared';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { ReservationStateMachineService } from '../reservations/reservation-state-machine.service.js';
import { PartnerAdaptor } from '../adaptors/partner-adaptor.interface.js';
import { WebhookAcknowledgmentDto } from './dto/webhook-response.dto.js';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject('ADAPTOR_REGISTRY')
    private readonly adaptors: Map<string, PartnerAdaptor>,
    private readonly idempotencyService: IdempotencyService,
    private readonly stateMachineService: ReservationStateMachineService,
  ) {}

  @Post(':partnerSlug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive partner webhook',
    description:
      'Ingests an inbound reservation webhook from a partner. ' +
      'The payload is verified using the partner-specific authentication strategy (API-Key, OAuth2, HMAC-SHA256), ' +
      'normalised into the canonical reservation schema, deduplicated via idempotency keys, ' +
      'and processed through the reservation state machine.',
  })
  @ApiParam({ name: 'partnerSlug', description: 'Partner identifier slug (e.g. partner_a, partner_b)', example: 'partner_a' })
  @ApiSecurity('PartnerApiKey')
  @ApiBody({ description: 'Raw partner reservation payload (format varies by partner).' })
  @ApiOkResponse({ description: 'Webhook acknowledged; reservation created or updated.', type: WebhookAcknowledgmentDto })
  @ApiBadRequestResponse({ description: 'No adaptor registered for the given partner slug.' })
  @ApiUnauthorizedResponse({ description: 'Webhook signature / credential verification failed.' })
  @ApiUnprocessableEntityResponse({ description: 'Unable to resolve property mapping or canonical schema validation failed.' })
  async handleIncomingWebhook(
    @Param('partnerSlug') partnerSlug: string,
    @Headers() headers: Record<string, string | string[]>,
    @Req() req: Request,
  ) {
    const adaptor = this.adaptors.get(partnerSlug);
    if (!adaptor) {
      throw new BadRequestException(`No adaptor registered for partner '${partnerSlug}'`);
    }

    // Retrieve raw body buffer for HMAC-SHA256 signature calculation
    const rawBuffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));

    // 1. Authenticate and verify payload integrity
    const validation = await adaptor.verifyWebhook(headers, rawBuffer);
    if (!validation.isValid) {
      throw new UnauthorizedException(validation.error || 'Webhook validation failed');
    }

    // Use partner-provided idempotency key or fallback to SHA-256 content-hash of the raw body
    const idempotencyKey =
      validation.idempotencyKey ||
      `${partnerSlug}:${createHash('sha256').update(rawBuffer).digest('hex')}`;

    // 2. Check and acquire idempotency lock
    const { isDuplicate, cachedResponse } = await this.idempotencyService.acquireOrReplay(
      idempotencyKey,
      `WEBHOOK:${partnerSlug.toUpperCase()}`,
      30,
    );

    if (isDuplicate) {
      return cachedResponse;
    }

    try {
      // 3. Resolve partner entity
      const partner = await prisma.partner.findUniqueOrThrow({
        where: { slug: partnerSlug },
      });

      // 4. Resolve internal property ID from partner mapping
      const externalPropertyCode =
        validation.parsedBody?.property_id ||
        validation.parsedBody?.reservation?.resort_id ||
        validation.parsedBody?.hotel_code;

      if (!externalPropertyCode) {
        throw new UnprocessableEntityException(
          `Unable to resolve external property code from webhook payload for partner '${partnerSlug}'`,
        );
      }

      const mapping = await prisma.propertyPartnerMapping.findFirst({
        where: {
          partnerId: partner.id,
          externalPropertyId: String(externalPropertyCode),
        },
      });

      if (!mapping) {
        throw new UnprocessableEntityException(
          `Property mapping not configured for partner '${partnerSlug}' and external property '${externalPropertyCode}'`,
        );
      }

      const propertyId = mapping.propertyId;

      // 5. Normalize payload using the adaptor
      const normalized = await adaptor.transformInboundReservation({
        ...validation.parsedBody,
        internal_property_id: propertyId,
      });

      // Validate normalized payload with Zod canonical schema
      const parseResult = CanonicalReservationSchema.omit({ reservationId: true }).safeParse(
        normalized,
      );
      if (!parseResult.success) {
        throw new UnprocessableEntityException({
          message: 'Normalized payload failed canonical schema validation',
          errors: parseResult.error.errors,
        });
      }
      const validatedPayload = parseResult.data;

      // 6. Transition reservation state
      const result = await this.stateMachineService.processTransition({
        partnerId: partner.id,
        externalBookingId: validatedPayload.externalBookingId,
        targetStatus: validatedPayload.status,
        propertyId: validatedPayload.propertyId,
        inventoryUnitCode: validatedPayload.inventoryUnitCode,
        checkInDate: validatedPayload.checkInDate,
        checkOutDate: validatedPayload.checkOutDate,
        unitsBooked: validatedPayload.unitsBooked,
        guestName: validatedPayload.guestName,
        guestEmail: validatedPayload.guestEmail,
        totalPriceCents: validatedPayload.totalPriceCents,
        currency: validatedPayload.currency,
        rawPayload: validation.parsedBody,
      });

      const responsePayload = {
        acknowledged: true,
        reservationId: result.id,
        status: result.status,
        timestamp: new Date().toISOString(),
      };

      // 7. Persist result to release idempotency lock
      await this.idempotencyService.commit(idempotencyKey, HttpStatus.OK, responsePayload);

      return responsePayload;
    } catch (error) {
      await this.idempotencyService.rollback(idempotencyKey);
      this.logger.error(`Failed handling webhook for ${partnerSlug}:`, error);
      throw error;
    }
  }
}

