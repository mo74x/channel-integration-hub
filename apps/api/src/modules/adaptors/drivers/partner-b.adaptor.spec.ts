import { ConfigService } from '@nestjs/config';
import { ReservationStatus } from '@cih/shared';
import { PartnerBAdaptor } from './partner-b.adaptor.js';

describe('PartnerBAdaptor', () => {
  let adaptor: PartnerBAdaptor;
  let mockConfigService: jest.Mocked<ConfigService>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'PARTNER_B_CLIENT_ID') return 'test_client_id';
        if (key === 'PARTNER_B_CLIENT_SECRET') return 'test_client_secret';
        if (key === 'PARTNER_B_BASE_URL') return 'http://localhost:4000/partner-b';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    adaptor = new PartnerBAdaptor(mockConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('capabilities & webhooks', () => {
    it('exposes correct capabilities for polling-only architecture', () => {
      expect(adaptor.capabilities).toEqual({
        webhooks: false,
        polling: true,
        inventoryPush: false,
      });
    });

    it('declares webhooks unsupported', async () => {
      const result = await adaptor.verifyWebhook();
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Polling architecture only');
    });

    it('pushInventory returns success default', async () => {
      const res = await adaptor.pushInventory();
      expect(res.success).toBe(true);
    });
  });

  describe('OAuth token caching & refresh', () => {
    it('fetches new access token on first call and caches it', async () => {
      const tokenResponse = () =>
        new Response(
          JSON.stringify({ access_token: 'tok_123', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      const reservationsResponse = () =>
        new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(reservationsResponse())
        .mockResolvedValueOnce(reservationsResponse());

      // First pull: should request token then poll
      await adaptor.pullReservations('EXT-PROP-B');
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Second pull: should reuse cached token without requesting another token
      await adaptor.pullReservations('EXT-PROP-B');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('refreshes token when cached token has expired or is within 60s window', async () => {
      const tokenResponse1 = new Response(
        JSON.stringify({ access_token: 'tok_first', expires_in: 50 }), // expires in 50s (< 60s threshold)
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      const tokenResponse2 = new Response(
        JSON.stringify({ access_token: 'tok_second', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      const emptyReservations = () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(tokenResponse1)
        .mockResolvedValueOnce(emptyReservations())
        .mockResolvedValueOnce(tokenResponse2)
        .mockResolvedValueOnce(emptyReservations());

      await adaptor.pullReservations('EXT-PROP-B');
      // Because expires_in is 50s, now >= tokenExpiresAt - 60000, so next call refreshes token
      await adaptor.pullReservations('EXT-PROP-B');

      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('throws error when OAuth request fails', async () => {
      const errorResponse = new Response('Unauthorized', { status: 401 });
      global.fetch = jest.fn().mockResolvedValue(errorResponse);

      await expect(adaptor.pullReservations('EXT-PROP-B')).rejects.toThrow();
    });
  });

  describe('pullReservations & filtering', () => {
    it('filters records by externalPropertyId and appends since parameter', async () => {
      const tokenResponse = new Response(
        JSON.stringify({ access_token: 'tok_valid', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

      const records = [
        {
          hotel_code: 'EXT-PROP-B-1',
          pms_reservation_id: 'PMS-101',
          internal_property_id: 'prop-1',
          room_category: 'DELUXE_KING',
          booking_window: { start_date: '2026-11-01', end_date: '2026-11-03' },
          rooms_count: 1,
          guest_details: { full_name: 'George Washington', email: 'george@example.com' },
          financials: { total_amount: 320.0, currency_code: 'USD' },
          current_status: 'BOOKED',
        },
        {
          hotel_code: 'OTHER-HOTEL-99',
          pms_reservation_id: 'PMS-999',
          room_category: 'STANDARD',
          booking_window: { start_date: '2026-11-01', end_date: '2026-11-03' },
          rooms_count: 1,
          guest_details: { full_name: 'Ignored Guest', email: 'ignored@example.com' },
          financials: { total_amount: 100.0, currency_code: 'USD' },
          current_status: 'BOOKED',
        },
      ];

      const resResponse = new Response(JSON.stringify({ data: records }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(tokenResponse)
        .mockResolvedValueOnce(resResponse);

      const since = new Date('2026-10-01T00:00:00Z');
      const results = await adaptor.pullReservations('EXT-PROP-B-1', since);

      expect(results).toHaveLength(1);
      expect(results[0].externalBookingId).toBe('PMS-101');
      expect(results[0].status).toBe(ReservationStatus.CONFIRMED);

      // Verify URL included ?since= query parameter
      const pollUrl = (global.fetch as jest.Mock).mock.calls[1][0];
      expect(pollUrl).toContain('?since=');
      expect(pollUrl).toContain('2026-10-01T00%3A00%3A00.000Z');
    });
  });

  describe('transformInboundReservation', () => {
    it('transforms BOOKED status to CONFIRMED and converts financials to cents', async () => {
      const raw = {
        pms_reservation_id: 'B-123',
        internal_property_id: 'prop-uuid-b',
        room_category: 'SUITE',
        booking_window: { start_date: '2026-11-10', end_date: '2026-11-15' },
        rooms_count: 2,
        guest_details: { full_name: 'Sara Connor', email: 'sara@example.com' },
        financials: { total_amount: 750.5, currency_code: 'USD' },
        current_status: 'BOOKED',
      };

      const transformed = await adaptor.transformInboundReservation(raw);

      expect(transformed).toEqual({
        externalBookingId: 'B-123',
        propertyId: 'prop-uuid-b',
        inventoryUnitCode: 'SUITE',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-15',
        unitsBooked: 2,
        guestName: 'Sara Connor',
        guestEmail: 'sara@example.com',
        totalPriceCents: 75050,
        currency: 'USD',
        status: ReservationStatus.CONFIRMED,
        metadata: { polledFrom: 'PartnerB_PMS' },
      });
    });

    it('transforms CANCELLED status correctly', async () => {
      const raw = {
        pms_reservation_id: 'B-456',
        internal_property_id: 'prop-uuid-b',
        room_category: 'STANDARD',
        booking_window: { start_date: '2026-12-01', end_date: '2026-12-05' },
        rooms_count: 1,
        guest_details: { full_name: 'John Connor' },
        financials: { total_amount: 100.0, currency_code: 'EUR' },
        current_status: 'CANCELLED',
      };

      const transformed = await adaptor.transformInboundReservation(raw);
      expect(transformed.status).toBe(ReservationStatus.CANCELLED);
      expect(transformed.currency).toBe('EUR');
    });
  });
});
