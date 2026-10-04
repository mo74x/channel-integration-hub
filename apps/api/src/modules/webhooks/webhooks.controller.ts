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
  Inject,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { prisma } from '@cih/database';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { ReservationStateMachineService } from '../reservations/reservation-state-machine.service.js';
import { PartnerAdaptor } from '../adaptors/partner-adaptor.interface.js';

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

    const idempotencyKey = validation.idempotencyKey || `${partnerSlug}:${Date.now()}`;

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

      const mapping = await prisma.propertyPartnerMapping.findFirst({
        where: {
          partnerId: partner.id,
          externalPropertyId: externalPropertyCode,
        },
      });

      const propertyId = mapping?.propertyId || '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

      // 5. Normalize payload using the adaptor
      const normalized = await adaptor.transformInboundReservation({
        ...validation.parsedBody,
        internal_property_id: propertyId,
      });

      // 6. Transition reservation state
      const result = await this.stateMachineService.processTransition({
        partnerId: partner.id,
        externalBookingId: normalized.externalBookingId,
        targetStatus: normalized.status,
        propertyId: normalized.propertyId,
        inventoryUnitCode: normalized.inventoryUnitCode,
        checkInDate: normalized.checkInDate,
        checkOutDate: normalized.checkOutDate,
        unitsBooked: normalized.unitsBooked,
        guestName: normalized.guestName,
        guestEmail: normalized.guestEmail,
        totalPriceCents: normalized.totalPriceCents,
        currency: normalized.currency,
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