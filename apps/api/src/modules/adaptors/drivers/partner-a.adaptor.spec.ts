import { ConfigService } from '@nestjs/config';
import { ReservationStatus } from '@cih/shared';
import { PartnerAAdaptor } from './partner-a.adaptor.js';

describe('PartnerAAdaptor', () => {
  let adaptor: PartnerAAdaptor;
  let mockConfigService: jest.Mocked<ConfigService>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'PARTNER_A_API_KEY') return 'test_partner_a_secret_key';
        if (key === 'PARTNER_A_BASE_URL') return 'http://localhost:4000/partner-a';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    adaptor = new PartnerAAdaptor(mockConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('capabilities', () => {
    it('exposes correct capabilities', () => {
      expect(adaptor.capabilities).toEqual({
        webhooks: true,
        polling: false,
        inventoryPush: true,
      });
    });
  });

  describe('auth & webhook verification', () => {
    it('validates webhook successfully with timing-safe comparison when key matches', async () => {
      const headers = { 'x-api-key': 'test_partner_a_secret_key', 'x-idempotency-key': 'idem-1' };
      const rawBody = JSON.stringify({ booking_reference: 'A-123' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_a:idem-1');
      expect(result.parsedBody).toEqual({ booking_reference: 'A-123' });
    });

    it('supports uppercase X-API-KEY header', async () => {
      const headers = { 'X-API-KEY': 'test_partner_a_secret_key' };
      const rawBody = JSON.stringify({ booking_reference: 'A-456' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_a:A-456');
    });

    it('rejects webhook with invalid API key', async () => {
      const headers = { 'x-api-key': 'wrong_invalid_key' };
      const rawBody = JSON.stringify({ booking_reference: 'A-123' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });

    it('rejects webhook when API key header is missing', async () => {
      const headers = {};
      const rawBody = JSON.stringify({ booking_reference: 'A-123' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });

    it('rejects webhook with malformed JSON body', async () => {
      const headers = { 'x-api-key': 'test_partner_a_secret_key' };
      const rawBody = '{invalid_json}';

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Malformed JSON payload');
    });

    it('falls back to payload transaction_id when header is missing', async () => {
      const headers = { 'x-api-key': 'test_partner_a_secret_key' };
      const rawBody = JSON.stringify({ transaction_id: 'tx-999', booking_reference: 'A-999' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_a:tx-999');
    });

    it('falls back to payload booking_reference when neither header nor transaction_id is present', async () => {
      const headers = { 'x-api-key': 'test_partner_a_secret_key' };
      const rawBody = JSON.stringify({ booking_reference: 'A-888' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_a:A-888');
    });
  });

  describe('transformInboundReservation', () => {
    it('normalizes confirmed booking with dollar amount converted to cents', async () => {
      const raw = {
        action: 'BOOK',
        booking_reference: 'A-100',
        internal_property_id: 'prop-uuid-1',
        room_type: 'DELUXE_KING',
        dates: { check_in: '2026-11-01', check_out: '2026-11-04' },
        units_count: '2',
        customer: { name: 'Alice Smith', email: 'alice@example.com' },
        payment: { amount: 450.75, currency: 'USD' },
      };

      const transformed = await adaptor.transformInboundReservation(raw);

      expect(transformed).toEqual({
        externalBookingId: 'A-100',
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-01',
        checkOutDate: '2026-11-04',
        unitsBooked: 2,
        guestName: 'Alice Smith',
        guestEmail: 'alice@example.com',
        totalPriceCents: 45075,
        currency: 'USD',
        status: ReservationStatus.CONFIRMED,
        metadata: { originalSource: 'PartnerA_REST' },
      });
    });

    it('normalizes cancellation with CANCEL action', async () => {
      const raw = {
        action: 'CANCEL',
        id: 'A-CANCEL-99',
        internal_property_id: 'prop-uuid-1',
        room_type: 'STANDARD_QUEEN',
        dates: { check_in: '2026-12-01', check_out: '2026-12-03' },
        units_count: 1,
        customer: { name: 'Bob Jones', email: 'bob@example.com' },
        payment: { amount: 200, currency: 'EUR' },
      };

      const transformed = await adaptor.transformInboundReservation(raw);
      expect(transformed.status).toBe(ReservationStatus.CANCELLED);
      expect(transformed.externalBookingId).toBe('A-CANCEL-99');
      expect(transformed.totalPriceCents).toBe(20000);
      expect(transformed.currency).toBe('EUR');
    });
  });

  describe('pushInventory & pullReservations', () => {
    it('pushes inventory updates successfully', async () => {
      const mockResponse = new Response(JSON.stringify({ acknowledgementId: 'ack_a_123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const update = {
        propertyId: 'prop-1',
        inventoryUnitCode: 'DELUXE_KING',
        date: '2026-11-01',
        availableUnits: 5,
        priceInCents: 25000,
      };

      const result = await adaptor.pushInventory(update);
      expect(result.success).toBe(true);
      expect(result.partnerSyncId).toBe('ack_a_123');
    });

    it('returns empty array on pullReservations as pull is unsupported', async () => {
      const pulled = await adaptor.pullReservations();
      expect(pulled).toEqual([]);
    });
  });
});
