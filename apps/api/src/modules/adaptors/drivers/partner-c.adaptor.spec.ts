import { createHmac } from 'node:crypto';
import { ReservationStatus } from '@cih/shared';
import { PartnerCAdaptor } from './partner-c.adaptor.js';

describe('PartnerCAdaptor', () => {
  let adaptor: PartnerCAdaptor;
  const testSecret = 'c8f126f5e92be2b1a8f940821d3e86f8';

  beforeEach(() => {
    process.env.PARTNER_C_HMAC_SECRET = testSecret;
    adaptor = new PartnerCAdaptor();
  });

  describe('capabilities', () => {
    it('exposes correct capabilities for webhook-only architecture', () => {
      expect(adaptor.capabilities).toEqual({
        webhooks: true,
        polling: false,
        inventoryPush: false,
      });
    });

    it('pushInventory and pullReservations return default stubs', async () => {
      const pushRes = await adaptor.pushInventory();
      expect(pushRes.success).toBe(true);

      const pullRes = await adaptor.pullReservations();
      expect(pullRes).toEqual([]);
    });
  });

  describe('Security, Headers & Signature Verification', () => {
    it('accepts valid signature matching payload and current timestamp', async () => {
      const rawBody = JSON.stringify({ reservation: { booking_ref: 'STAR-123' } });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', testSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

      const headers = {
        'x-starlight-signature': signature,
        'x-starlight-timestamp': timestamp,
        'x-starlight-event-id': 'evt_valid_1',
      };

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_c:evt_valid_1');
    });

    it('rejects when signature header is missing', async () => {
      const rawBody = JSON.stringify({ test: 1 });
      const headers = {
        'x-starlight-timestamp': Math.floor(Date.now() / 1000).toString(),
        'x-starlight-event-id': 'evt_1',
      };

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Missing HMAC signature');
    });

    it('rejects when timestamp header is missing', async () => {
      const rawBody = JSON.stringify({ test: 1 });
      const headers = {
        'x-starlight-signature': 'sig',
        'x-starlight-event-id': 'evt_1',
      };

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Missing HMAC signature');
    });

    it('rejects when event-id header is missing', async () => {
      const rawBody = JSON.stringify({ test: 1 });
      const headers = {
        'x-starlight-signature': 'sig',
        'x-starlight-timestamp': Math.floor(Date.now() / 1000).toString(),
      };

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Missing HMAC signature');
    });

    it('rejects tampered payload even with a valid timestamp', async () => {
      const originalBody = JSON.stringify({ reservation: { booking_ref: 'STAR-123' } });
      const tamperedBody = JSON.stringify({ reservation: { booking_ref: 'STAR-HACKED' } });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const signature = createHmac('sha256', testSecret)
        .update(`${timestamp}.${originalBody}`)
        .digest('hex');

      const headers = {
        'x-starlight-signature': signature,
        'x-starlight-timestamp': timestamp,
        'x-starlight-event-id': 'evt_tampered_1',
      };

      const result = await adaptor.verifyWebhook(headers, tamperedBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Cryptographic signature verification failed');
    });

    it('rejects replay attacks when timestamp drift exceeds 300 seconds', async () => {
      const rawBody = JSON.stringify({ reservation: { booking_ref: 'STAR-123' } });
      const staleTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();

      const signature = createHmac('sha256', testSecret)
        .update(`${staleTimestamp}.${rawBody}`)
        .digest('hex');

      const headers = {
        'x-starlight-signature': signature,
        'x-starlight-timestamp': staleTimestamp,
        'x-starlight-event-id': 'evt_stale_1',
      };

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('drift exceeded 300 seconds');
    });

    it('rejects malformed non-JSON payload even if HMAC is calculated over the raw string', async () => {
      const rawBody = 'not a valid json payload';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', testSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

      const headers = {
        'x-starlight-signature': signature,
        'x-starlight-timestamp': timestamp,
        'x-starlight-event-id': 'evt_bad_json',
      };

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid JSON payload structure');
    });
  });

  describe('transformInboundReservation', () => {
    it('normalizes confirmed booking reservation payload', async () => {
      const raw = {
        internal_property_id: '00000000-0000-0000-0000-000000000003',
        reservation: {
          booking_ref: 'STAR-999',
          unit_type: 'DELUXE_KING',
          lifecycle_state: 'CONFIRMED',
          stay: {
            arrival: '2026-11-20',
            departure: '2026-11-25',
            quantity: 2,
          },
          guest: {
            name: 'Leonard McCoy',
            contact: 'mccoy@starfleet.com',
          },
          pricing: {
            charged_amount_cents: 65000,
            currency: 'USD',
          },
        },
        event_meta: {
          event_id: 'evt-001',
        },
      };

      const normalized = await adaptor.transformInboundReservation(raw);

      expect(normalized).toEqual({
        externalBookingId: 'STAR-999',
        propertyId: '00000000-0000-0000-0000-000000000003',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-20',
        checkOutDate: '2026-11-25',
        unitsBooked: 2,
        guestName: 'Leonard McCoy',
        guestEmail: 'mccoy@starfleet.com',
        totalPriceCents: 65000,
        currency: 'USD',
        status: ReservationStatus.CONFIRMED,
        metadata: { eventId: 'evt-001' },
      });
    });

    it('normalizes cancellation reservation payload', async () => {
      const raw = {
        internal_property_id: 'prop-c-uuid',
        reservation: {
          booking_ref: 'STAR-CANCEL-1',
          unit_type: 'STANDARD_QUEEN',
          lifecycle_state: 'CANCELLED',
          stay: {
            arrival: '2026-12-01',
            departure: '2026-12-05',
          },
          guest: {
            name: 'Spock',
            contact: 'spock@starfleet.com',
          },
          pricing: {
            charged_amount_cents: 35000,
            currency: 'EUR',
          },
        },
      };

      const normalized = await adaptor.transformInboundReservation(raw);
      expect(normalized.status).toBe(ReservationStatus.CANCELLED);
      expect(normalized.unitsBooked).toBe(1); // defaults to 1
      expect(normalized.currency).toBe('EUR');
    });
  });
});