import { ConfigService } from '@nestjs/config';
import { ReservationStatus } from '@cih/shared';
import { PartnerDAdaptor } from './partner-d.adaptor.js';

describe('PartnerDAdaptor', () => {
  let adaptor: PartnerDAdaptor;
  let mockConfigService: jest.Mocked<ConfigService>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'PARTNER_D_API_KEY') return 'test_partner_d_secret_key';
        if (key === 'PARTNER_D_BASE_URL') return 'http://localhost:4000/partner-d';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    adaptor = new PartnerDAdaptor(mockConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('capabilities', () => {
    it('exposes correct capabilities for webhooks + push architecture', () => {
      expect(adaptor.capabilities).toEqual({
        webhooks: true,
        polling: false,
        inventoryPush: true,
      });
    });
  });

  describe('verifyWebhook', () => {
    it('validates webhook successfully with x-api-key header', async () => {
      const headers = {
        'x-api-key': 'test_partner_d_secret_key',
        'x-idempotency-key': 'idem-d-123',
      };
      const rawBody = JSON.stringify({ booking_reference: 'D-999', property_id: 'prop-1' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_d:idem-d-123');
      expect(result.parsedBody).toEqual({ booking_reference: 'D-999', property_id: 'prop-1' });
    });

    it('validates webhook successfully with Authorization Bearer header', async () => {
      const headers = {
        authorization: 'Bearer test_partner_d_secret_key',
      };
      const rawBody = JSON.stringify({ booking_id: 'D-888' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_d:D-888');
    });

    it('validates webhook successfully with Authorization ApiKey header', async () => {
      const headers = {
        authorization: 'ApiKey test_partner_d_secret_key',
      };
      const rawBody = JSON.stringify({ id: 'D-777' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(true);
      expect(result.idempotencyKey).toBe('partner_d:D-777');
    });

    it('rejects webhook with invalid API key', async () => {
      const headers = { 'x-api-key': 'invalid_secret_key' };
      const rawBody = JSON.stringify({ booking_reference: 'D-123' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });

    it('rejects webhook when API key is missing', async () => {
      const headers = {};
      const rawBody = JSON.stringify({ booking_reference: 'D-123' });

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });

    it('rejects webhook with malformed JSON body', async () => {
      const headers = { 'x-api-key': 'test_partner_d_secret_key' };
      const rawBody = 'this is not valid json';

      const result = await adaptor.verifyWebhook(headers, rawBody);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Malformed JSON payload');
    });
  });

  describe('transformInboundReservation', () => {
    it('normalizes confirmed reservation payload correctly', async () => {
      const raw = {
        booking_id: 'BK-1001',
        internal_property_id: '00000000-0000-0000-0000-000000000001',
        room_type: 'DELUXE_KING',
        check_in_date: '2026-11-01',
        check_out_date: '2026-11-05',
        units_count: 2,
        guest: {
          name: 'Jane Doe',
          email: 'jane@example.com',
        },
        payment: {
          amount: 500.5,
          currency: 'USD',
        },
        status: 'CONFIRMED',
      };

      const normalized = await adaptor.transformInboundReservation(raw);

      expect(normalized).toEqual({
        externalBookingId: 'BK-1001',
        propertyId: '00000000-0000-0000-0000-000000000001',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-01',
        checkOutDate: '2026-11-05',
        unitsBooked: 2,
        guestName: 'Jane Doe',
        guestEmail: 'jane@example.com',
        totalPriceCents: 50050,
        currency: 'USD',
        status: ReservationStatus.CONFIRMED,
        metadata: { originalSource: 'PartnerD_REST' },
      });
    });

    it('normalizes cancellation reservation payload correctly', async () => {
      const raw = {
        booking_reference: 'BK-CANCEL-1',
        property_id: '00000000-0000-0000-0000-000000000002',
        unit_code: 'STANDARD_QUEEN',
        dates: {
          check_in: '2026-12-10',
          check_out: '2026-12-12',
        },
        action: 'CANCEL',
        total_price_cents: 30000,
        currency: 'EUR',
      };

      const normalized = await adaptor.transformInboundReservation(raw);

      expect(normalized.status).toBe(ReservationStatus.CANCELLED);
      expect(normalized.externalBookingId).toBe('BK-CANCEL-1');
      expect(normalized.propertyId).toBe('00000000-0000-0000-0000-000000000002');
      expect(normalized.inventoryUnitCode).toBe('STANDARD_QUEEN');
      expect(normalized.checkInDate).toBe('2026-12-10');
      expect(normalized.checkOutDate).toBe('2026-12-12');
      expect(normalized.totalPriceCents).toBe(30000);
      expect(normalized.currency).toBe('EUR');
    });
  });

  describe('pushInventory', () => {
    it('successfully pushes inventory updates to Partner D endpoint', async () => {
      const mockResponse = new Response(
        JSON.stringify({ acknowledgementId: 'ack_d_12345' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const update = {
        propertyId: '00000000-0000-0000-0000-000000000001',
        inventoryUnitCode: 'DELUXE_KING',
        date: '2026-11-01',
        availableUnits: 4,
        priceInCents: 25000,
      };

      const result = await adaptor.pushInventory(update);

      expect(result.success).toBe(true);
      expect(result.partnerSyncId).toBe('ack_d_12345');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4000/partner-d/inventory',
        expect.objectContaining({
          method: 'POST',
        }),
      );
      const callOptions = (global.fetch as jest.Mock).mock.calls[0][1];
      const headerVal =
        typeof callOptions.headers.get === 'function'
          ? callOptions.headers.get('x-api-key')
          : callOptions.headers['x-api-key'];
      expect(headerVal).toBe('test_partner_d_secret_key');
    });

    it('throws error when inventory push fails', async () => {
      const mockResponse = new Response('Server Error', { status: 500 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const update = {
        propertyId: '00000000-0000-0000-0000-000000000001',
        inventoryUnitCode: 'DELUXE_KING',
        date: '2026-11-01',
        availableUnits: 4,
        priceInCents: 25000,
      };

      await expect(adaptor.pushInventory(update)).rejects.toThrow(/500/);
    });
  });

  describe('pullReservations', () => {
    it('returns an empty array as Partner D uses webhooks only', async () => {
      const reservations = await adaptor.pullReservations();
      expect(reservations).toEqual([]);
    });
  });
});
