import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { ReservationStatus, CanonicalReservationPayload } from '@cih/shared';
import { PartnerAdaptor, PartnerCapabilities, WebhookValidationResult } from '../partner-adaptor.interface.js';
import { safeCompare } from '../../../common/crypto/safe-compare.js';

@Injectable()
export class PartnerCAdaptor implements PartnerAdaptor {
  readonly partnerSlug = 'partner_c';
  readonly capabilities: PartnerCapabilities = {
    webhooks: true,
    polling: false,
    inventoryPush: false,
  };
  private readonly maxDriftSeconds = 300; // 5-minute replay attack threshold

  constructor(
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  private get hmacSecret(): string {
    return (
      this.configService?.get<string>('PARTNER_C_HMAC_SECRET') ||
      process.env.PARTNER_C_HMAC_SECRET ||
      'c8f126f5e92be2b1a8f940821d3e86f8'
    );
  }

  async verifyWebhook(
    headers: Record<string, string | string[]>,
    rawBody: Buffer | string,
  ): Promise<WebhookValidationResult> {
    const rawSig = headers['x-starlight-signature'];
    const signature = Array.isArray(rawSig) ? rawSig[0] : (rawSig as string);
    const rawTs = headers['x-starlight-timestamp'];
    const timestamp = Array.isArray(rawTs) ? rawTs[0] : (rawTs as string);
    const rawEventId = headers['x-starlight-event-id'];
    const eventId = Array.isArray(rawEventId) ? rawEventId[0] : (rawEventId as string);

    if (!signature || !timestamp || !eventId) {
      return { isValid: false, error: 'Missing HMAC signature, timestamp, or event-id headers' };
    }

    // Enforce replay attack window
    const now = Math.floor(Date.now() / 1000);
    const sentTime = parseInt(timestamp, 10);
    if (isNaN(sentTime) || Math.abs(now - sentTime) > this.maxDriftSeconds) {
      return { isValid: false, error: 'Webhook rejected: Timestamp drift exceeded 300 seconds' };
    }

    // Validate cryptographic signature using constant-time comparison
    const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const expectedSignature = createHmac('sha256', this.hmacSecret)
      .update(`${timestamp}.${rawBuffer.toString('utf-8')}`)
      .digest('hex');

    if (!safeCompare(signature, expectedSignature)) {
      return { isValid: false, error: 'Cryptographic signature verification failed' };
    }

    try {
      const parsed = JSON.parse(rawBuffer.toString('utf-8'));
      return {
        isValid: true,
        idempotencyKey: `partner_c:${eventId}`,
        parsedBody: parsed,
      };
    } catch {
      return { isValid: false, error: 'Invalid JSON payload structure' };
    }
  }

  async transformInboundReservation(raw: any): Promise<Omit<CanonicalReservationPayload, 'reservationId'>> {
    const res = raw.reservation;
    let status: ReservationStatus = ReservationStatus.PENDING;

    if (res.lifecycle_state === 'CONFIRMED') status = ReservationStatus.CONFIRMED;
    if (res.lifecycle_state === 'CANCELLED') status = ReservationStatus.CANCELLED;

    return {
      externalBookingId: res.booking_ref,
      propertyId: raw.internal_property_id,
      inventoryUnitCode: res.unit_type,
      checkInDate: res.stay.arrival,
      checkOutDate: res.stay.departure,
      unitsBooked: res.stay.quantity || 1,
      guestName: res.guest.name,
      guestEmail: res.guest.contact,
      totalPriceCents: res.pricing.charged_amount_cents,
      currency: res.pricing.currency || 'USD',
      status,
      metadata: { eventId: raw.event_meta?.event_id },
    };
  }

  async pushInventory(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async pullReservations(): Promise<Array<Omit<CanonicalReservationPayload, 'reservationId'>>> {
    return [];
  }
}