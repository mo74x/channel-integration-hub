import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReservationStatus, CanonicalInventoryPushPayload, CanonicalReservationPayload } from '@cih/shared';
import { PartnerAdaptor, PartnerCapabilities, WebhookValidationResult } from '../partner-adaptor.interface.js';
import { safeCompare } from '../../../common/crypto/safe-compare.js';
import { fetchWithTimeout } from '../../../common/http/http-client.js';

@Injectable()
export class PartnerAAdaptor implements PartnerAdaptor {
  readonly partnerSlug = 'partner_a';
  readonly capabilities: PartnerCapabilities = {
    webhooks: true,
    polling: false,
    inventoryPush: true,
  };

  constructor(
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  private get expectedApiKey(): string {
    return (
      this.configService?.get<string>('PARTNER_A_API_KEY') ||
      process.env.PARTNER_A_API_KEY ||
      'cih_live_partner_a_key_98765'
    );
  }

  private get partnerBaseUrl(): string {
    return (
      this.configService?.get<string>('PARTNER_A_BASE_URL') ||
      process.env.PARTNER_A_BASE_URL ||
      'http://localhost:4000/partner-a'
    );
  }

  async verifyWebhook(
    headers: Record<string, string | string[]>,
    rawBody: Buffer | string,
  ): Promise<WebhookValidationResult> {
    const rawApiKey = headers['x-api-key'] || headers['X-API-KEY'];
    const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;

    if (!apiKey || !safeCompare(apiKey, this.expectedApiKey)) {
      return { isValid: false, error: 'Unauthorized: Invalid API key' };
    }

    try {
      const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf-8'));
      const idempotencyKey = (headers['x-idempotency-key'] as string) || parsed.transaction_id || parsed.booking_reference;

      return {
        isValid: true,
        idempotencyKey: `partner_a:${idempotencyKey}`,
        parsedBody: parsed,
      };
    } catch {
      return { isValid: false, error: 'Malformed JSON payload' };
    }
  }

  async transformInboundReservation(raw: any): Promise<Omit<CanonicalReservationPayload, 'reservationId'>> {
    let status: ReservationStatus = ReservationStatus.PENDING;
    if (raw.action === 'BOOK' || raw.status === 'CONFIRMED') status = ReservationStatus.CONFIRMED;
    if (raw.action === 'CANCEL' || raw.status === 'CANCELLED') status = ReservationStatus.CANCELLED;

    return {
      externalBookingId: raw.booking_reference || raw.id,
      propertyId: raw.internal_property_id,
      inventoryUnitCode: raw.room_type,
      checkInDate: raw.dates.check_in,
      checkOutDate: raw.dates.check_out,
      unitsBooked: Number(raw.units_count) || 1,
      guestName: raw.customer.name,
      guestEmail: raw.customer.email,
      totalPriceCents: Math.round(Number(raw.payment.amount) * 100),
      currency: raw.payment.currency || 'USD',
      status,
      metadata: { originalSource: 'PartnerA_REST' },
    };
  }

  async pushInventory(update: CanonicalInventoryPushPayload): Promise<{ success: boolean; partnerSyncId?: string }> {
    const payload = {
      property_id: update.propertyId,
      room_type_id: update.inventoryUnitCode,
      date: update.date,
      allotment: update.availableUnits,
      rate_cents: update.priceInCents,
    };

    const res = await fetchWithTimeout(`${this.partnerBaseUrl}/inventory`, {
      method: 'POST',
      partnerSlug: this.partnerSlug,
      timeoutMs: 10000,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.expectedApiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Partner A inventory push failed with status ${res.status}`);
    }

    const data = (await res.json()) as { acknowledgementId: string };
    return { success: true, partnerSyncId: data.acknowledgementId };
  }

  async pullReservations(): Promise<Array<Omit<CanonicalReservationPayload, 'reservationId'>>> {
    return []; // Partner A is webhook-driven; pull is not supported
  }
}