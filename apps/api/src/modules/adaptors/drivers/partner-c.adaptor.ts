import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ReservationStatus, CanonicalReservationPayload } from '@cih/shared';
import { PartnerAdaptor, WebhookValidationResult } from '../partner-adaptor.interface.js';

@Injectable()
export class PartnerCAdaptor implements PartnerAdaptor {
  readonly partnerSlug = 'partner_c';
  private readonly hmacSecret = process.env.PARTNER_C_HMAC_SECRET || 'c8f126f5e92be2b1a8f940821d3e86f8';
  private readonly maxDriftSeconds = 300; // 5-minute replay attack threshold

  async verifyWebhook(
    headers: Record<string, string | string[]>,
    rawBody: Buffer | string,
  ): Promise<WebhookValidationResult> {
    const signature = headers['x-starlight-signature'] as string;
    const timestamp = headers['x-starlight-timestamp'] as string;
    const eventId = headers['x-starlight-event-id'] as string;

    if (!signature || !timestamp || !eventId) {
      return { isValid: false, error: 'Missing HMAC signature, timestamp, or event-id headers' };
    }

    // 1. Enforce replay attack window
    const now = Math.floor(Date.now() / 1000);
    const sentTime = parseInt(timestamp, 10);
    if (isNaN(sentTime) || Math.abs(now - sentTime) > this.maxDriftSeconds) {
      return { isValid: false, error: 'Webhook rejected: Timestamp drift exceeded 300 seconds' };
    }

    // 2. Validate cryptographic signature using constant-time comparison
    const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const expectedSignature = createHmac('sha256', this.hmacSecret)
      .update(`${timestamp}.${rawBuffer.toString('utf-8')}`)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
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