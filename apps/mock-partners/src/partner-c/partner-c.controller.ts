import { Controller, Post, Body, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

@Controller('partner-c')
export class PartnerCController {
  private readonly logger = new Logger(PartnerCController.name);
  private readonly hmacSecret = process.env.PARTNER_C_HMAC_SECRET || 'c8f126f5e92be2b1a8f940821d3e86f8';

  /**
   * Utility endpoint that formats a sample Partner C webhook payload and signs it.
   */
  @Post('simulate-webhook')
  createSimulatedWebhookPayload(
    @Body()
    overridePayload?: {
      booking_ref?: string;
      unit_type?: string;
      status?: string;
      nights?: number;
    },
  ) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const eventId = `evt_c_${Date.now()}`;

    const payload = {
      event_meta: {
        event_id: eventId,
        timestamp,
        publisher: 'Starlight Resorts Engine',
      },
      reservation: {
        booking_ref: overridePayload?.booking_ref || `STAR-${Date.now()}`,
        resort_id: 'EXT-PROP-C-303',
        unit_type: overridePayload?.unit_type || 'DELUXE_KING',
        guest: {
          name: 'Sarah Connor',
          contact: 'sarah@resistance.org',
        },
        stay: {
          arrival: '2026-12-01',
          departure: '2026-12-05',
          quantity: 1,
        },
        pricing: {
          charged_amount_cents: 100000,
          currency: 'USD',
        },
        lifecycle_state: overridePayload?.status || 'CONFIRMED',
      },
    };

    const serialized = JSON.stringify(payload);
    const signature = createHmac('sha256', this.hmacSecret)
      .update(`${timestamp}.${serialized}`)
      .digest('hex');

    this.logger.log(`Partner C: Generated simulated webhook with ID ${eventId}`);

    return {
      headers: {
        'x-starlight-signature': signature,
        'x-starlight-timestamp': timestamp,
        'x-starlight-event-id': eventId,
        'content-type': 'application/json',
      },
      payload,
    };
  }
}