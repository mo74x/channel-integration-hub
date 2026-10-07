import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ReservationStatus,
  CanonicalInventoryPushPayload,
  CanonicalReservationPayload,
} from '@cih/shared';
import {
  PartnerAdaptor,
  PartnerCapabilities,
  WebhookValidationResult,
} from '../partner-adaptor.interface.js';
import { safeCompare } from '../../../common/crypto/safe-compare.js';
import { fetchWithTimeout } from '../../../common/http/http-client.js';

@Injectable()
export class PartnerDAdaptor implements PartnerAdaptor {
  readonly partnerSlug = 'partner_d';
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
      this.configService?.get<string>('PARTNER_D_API_KEY') ||
      process.env.PARTNER_D_API_KEY ||
      'cih_live_partner_d_key_112233'
    );
  }

  private get partnerBaseUrl(): string {
    return (
      this.configService?.get<string>('PARTNER_D_BASE_URL') ||
      process.env.PARTNER_D_BASE_URL ||
      'http://localhost:4000/partner-d'
    );
  }

  async verifyWebhook(
    headers: Record<string, string | string[]>,
    rawBody: Buffer | string,
  ): Promise<WebhookValidationResult> {
    let rawApiKey = headers['x-api-key'] || headers['X-API-KEY'];

    if (!rawApiKey && (headers['authorization'] || headers['Authorization'])) {
      const authHeader = (headers['authorization'] || headers['Authorization']) as string;
      rawApiKey = authHeader.replace(/^(Bearer|ApiKey)\s+/i, '');
    }

    const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;

    if (!apiKey || !safeCompare(apiKey, this.expectedApiKey)) {
      return { isValid: false, error: 'Unauthorized: Invalid API key' };
    }

    try {
      const parsed =
        typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf-8'));
      const idempotencyKey =
        (headers['x-idempotency-key'] as string) ||
        (headers['idempotency-key'] as string) ||
        parsed.idempotency_key ||
        parsed.transaction_id ||
        parsed.booking_reference ||
        parsed.booking_id ||
        parsed.reservation_id ||
        parsed.id;

      return {
        isValid: true,
        idempotencyKey: idempotencyKey ? `partner_d:${idempotencyKey}` : undefined,
        parsedBody: parsed,
      };
    } catch {
      return { isValid: false, error: 'Malformed JSON payload' };
    }
  }

  async transformInboundReservation(
    raw: any,
  ): Promise<Omit<CanonicalReservationPayload, 'reservationId'>> {
    let status: ReservationStatus = ReservationStatus.PENDING;
    const actionOrStatus = (raw.action || raw.status || raw.state || '').toUpperCase();
    if (
      actionOrStatus === 'BOOK' ||
      actionOrStatus === 'CONFIRM' ||
      actionOrStatus === 'CONFIRMED' ||
      actionOrStatus === 'BOOKED' ||
      actionOrStatus === 'CREATED'
    ) {
      status = ReservationStatus.CONFIRMED;
    } else if (
      actionOrStatus === 'CANCEL' ||
      actionOrStatus === 'CANCELLED' ||
      actionOrStatus === 'CANCELED'
    ) {
      status = ReservationStatus.CANCELLED;
    }

    const externalBookingId =
      raw.booking_reference || raw.booking_id || raw.reservation_id || raw.id;
    const propertyId = raw.internal_property_id || raw.property_id;
    const inventoryUnitCode =
      raw.room_type || raw.unit_code || raw.inventory_unit_code || raw.room_type_id;
    const checkInDate = raw.dates?.check_in || raw.check_in_date || raw.check_in;
    const checkOutDate = raw.dates?.check_out || raw.check_out_date || raw.check_out;
    const unitsBooked = Number(
      raw.units_count || raw.units || raw.rooms_count || raw.units_booked || 1,
    );
    const guestName = raw.customer?.name || raw.guest?.name || raw.guest_name || 'Unknown Guest';
    const guestEmail = raw.customer?.email || raw.guest?.email || raw.guest_email;

    let totalPriceCents = 0;
    if (raw.total_price_cents !== undefined) {
      totalPriceCents = Math.round(Number(raw.total_price_cents));
    } else if (raw.price_cents !== undefined) {
      totalPriceCents = Math.round(Number(raw.price_cents));
    } else if (raw.payment?.amount !== undefined) {
      totalPriceCents = Math.round(Number(raw.payment.amount) * 100);
    } else if (raw.total_amount !== undefined) {
      totalPriceCents = Math.round(Number(raw.total_amount) * 100);
    }

    const currency = raw.payment?.currency || raw.currency || 'USD';

    return {
      externalBookingId: String(externalBookingId),
      propertyId: String(propertyId),
      inventoryUnitCode: String(inventoryUnitCode),
      checkInDate: String(checkInDate),
      checkOutDate: String(checkOutDate),
      unitsBooked,
      guestName: String(guestName),
      guestEmail: guestEmail ? String(guestEmail) : undefined,
      totalPriceCents,
      currency: String(currency),
      status,
      metadata: { originalSource: 'PartnerD_REST', ...(raw.metadata || {}) },
    };
  }

  async pushInventory(
    update: CanonicalInventoryPushPayload,
  ): Promise<{ success: boolean; partnerSyncId?: string }> {
    const payload = {
      property_id: update.propertyId,
      unit_code: update.inventoryUnitCode,
      room_type_id: update.inventoryUnitCode,
      date: update.date,
      allotment: update.availableUnits,
      available_units: update.availableUnits,
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
      throw new Error(`Partner D inventory push failed with status ${res.status}`);
    }

    const data = (await res.json()) as { acknowledgementId?: string; sync_id?: string };
    return { success: true, partnerSyncId: data.acknowledgementId || data.sync_id };
  }

  async pullReservations(): Promise<Array<Omit<CanonicalReservationPayload, 'reservationId'>>> {
    return []; // Partner D is webhook-driven; polling is not supported
  }
}
