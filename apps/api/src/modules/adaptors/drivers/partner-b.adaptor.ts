import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReservationStatus, CanonicalReservationPayload } from '@cih/shared';
import {
  PartnerAdaptor,
  PartnerCapabilities,
  WebhookValidationResult,
} from '../partner-adaptor.interface.js';
import { fetchWithTimeout } from '../../../common/http/http-client.js';

@Injectable()
export class PartnerBAdaptor implements PartnerAdaptor {
  readonly partnerSlug = 'partner_b';
  readonly capabilities: PartnerCapabilities = {
    webhooks: false,
    polling: true,
    inventoryPush: false,
  };

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  private get partnerBaseUrl(): string {
    return (
      this.configService?.get<string>('PARTNER_B_BASE_URL') ||
      process.env.PARTNER_B_BASE_URL ||
      'http://localhost:4000/partner-b'
    );
  }

  private get clientId(): string {
    return (
      this.configService?.get<string>('PARTNER_B_CLIENT_ID') ||
      process.env.PARTNER_B_CLIENT_ID ||
      'client_b_channel_corp'
    );
  }

  private get clientSecret(): string {
    return (
      this.configService?.get<string>('PARTNER_B_CLIENT_SECRET') ||
      process.env.PARTNER_B_CLIENT_SECRET ||
      'secret_b_oauth_token_val'
    );
  }

  private async getValidAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt - 60000) {
      return this.cachedToken;
    }

    const res = await fetchWithTimeout(`${this.partnerBaseUrl}/oauth/token`, {
      method: 'POST',
      partnerSlug: this.partnerSlug,
      timeoutMs: 10000,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(`OAuth2 authentication failed with status ${res.status}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.cachedToken;
  }

  async verifyWebhook(): Promise<WebhookValidationResult> {
    return {
      isValid: false,
      error: 'Partner B does not emit webhooks (Polling architecture only)',
    };
  }

  async transformInboundReservation(
    raw: any,
  ): Promise<Omit<CanonicalReservationPayload, 'reservationId'>> {
    let status: ReservationStatus = ReservationStatus.PENDING;
    if (raw.current_status === 'BOOKED') status = ReservationStatus.CONFIRMED;
    if (raw.current_status === 'CANCELLED') status = ReservationStatus.CANCELLED;

    return {
      externalBookingId: raw.pms_reservation_id,
      propertyId: raw.internal_property_id,
      inventoryUnitCode: raw.room_category,
      checkInDate: raw.booking_window.start_date,
      checkOutDate: raw.booking_window.end_date,
      unitsBooked: raw.rooms_count,
      guestName: raw.guest_details.full_name,
      guestEmail: raw.guest_details.email,
      totalPriceCents: Math.round(raw.financials.total_amount * 100),
      currency: raw.financials.currency_code,
      status,
      metadata: { polledFrom: 'PartnerB_PMS' },
    };
  }

  async pushInventory(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async pullReservations(
    externalPropertyId: string,
    since?: Date,
  ): Promise<Array<Omit<CanonicalReservationPayload, 'reservationId'>>> {
    const token = await this.getValidAccessToken();
    const query = since ? `?since=${encodeURIComponent(since.toISOString())}` : '';

    const res = await fetchWithTimeout(`${this.partnerBaseUrl}/reservations${query}`, {
      partnerSlug: this.partnerSlug,
      timeoutMs: 10000,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Partner B reservations poll failed with status ${res.status}`);
    }

    const json = (await res.json()) as { data: any[] };
    const mapped: Array<Omit<CanonicalReservationPayload, 'reservationId'>> = [];

    for (const record of json.data) {
      if (record.hotel_code === externalPropertyId) {
        mapped.push(await this.transformInboundReservation(record));
      }
    }

    return mapped;
  }
}
