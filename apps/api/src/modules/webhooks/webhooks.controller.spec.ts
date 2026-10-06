import { UnprocessableEntityException,} from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { PartnerAdaptor } from '../adaptors/partner-adaptor.interface.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { ReservationStateMachineService } from '../reservations/reservation-state-machine.service.js';
import { prisma } from '@cih/database';
import { createHash } from 'node:crypto';

jest.mock('@cih/database', () => ({
  prisma: {
    partner: {
      findUniqueOrThrow: jest.fn(),
    },
    propertyPartnerMapping: {
      findFirst: jest.fn(),
    },
  },
}));

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let mockAdaptor: jest.Mocked<PartnerAdaptor>;
  let mockIdempotencyService: jest.Mocked<IdempotencyService>;
  let mockStateMachine: jest.Mocked<ReservationStateMachineService>;
  let adaptorsMap: Map<string, PartnerAdaptor>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAdaptor = {
      partnerSlug: 'partner_c',
      verifyWebhook: jest.fn(),
      transformInboundReservation: jest.fn(),
    } as unknown as jest.Mocked<PartnerAdaptor>;

    adaptorsMap = new Map([['partner_c', mockAdaptor]]);

    mockIdempotencyService = {
      acquireOrReplay: jest.fn().mockResolvedValue({ isDuplicate: false }),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IdempotencyService>;

    mockStateMachine = {
      processTransition: jest.fn().mockResolvedValue({ id: 'res-1', status: 'CONFIRMED' }),
    } as unknown as jest.Mocked<ReservationStateMachineService>;

    controller = new WebhooksController(
      adaptorsMap,
      mockIdempotencyService,
      mockStateMachine,
    );
  });

  it('throws 422 UnprocessableEntityException when property mapping is missing', async () => {
    const rawBody = JSON.stringify({ property_id: 'EXT-PROP-999', data: {} });
    mockAdaptor.verifyWebhook.mockResolvedValueOnce({
      isValid: true,
      idempotencyKey: 'key-123',
      parsedBody: { property_id: 'EXT-PROP-999' },
    });

    (prisma.partner.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ id: 'part-1', slug: 'partner_c' });
    (prisma.propertyPartnerMapping.findFirst as jest.Mock).mockResolvedValueOnce(null); // Missing mapping!

    const mockReq = { rawBody: Buffer.from(rawBody) } as any;

    await expect(
      controller.handleIncomingWebhook('partner_c', {}, mockReq),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(prisma.propertyPartnerMapping.findFirst).toHaveBeenCalledWith({
      where: { partnerId: 'part-1', externalPropertyId: 'EXT-PROP-999' },
    });
    // Verifies the hard-coded UUID fallback was removed and adaptor was not called
    expect(mockAdaptor.transformInboundReservation).not.toHaveBeenCalled();
  });

  it('uses SHA-256 content-hash of the raw body when partner sends no idempotency key', async () => {
    const rawBody = JSON.stringify({ property_id: 'EXT-PROP-1', booking: '123' });
    const expectedHash = createHash('sha256').update(rawBody).digest('hex');

    mockAdaptor.verifyWebhook.mockResolvedValueOnce({
      isValid: true,
      idempotencyKey: undefined, // Partner sends no key!
      parsedBody: { property_id: 'EXT-PROP-1' },
    });

    (prisma.partner.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ id: 'part-1', slug: 'partner_c' });
    (prisma.propertyPartnerMapping.findFirst as jest.Mock).mockResolvedValueOnce({ propertyId: 'c9f0b188-39dc-4613-81ef-42d4a23bca01' });

    mockAdaptor.transformInboundReservation.mockResolvedValueOnce({
      externalBookingId: 'BOOK-1',
      propertyId: 'c9f0b188-39dc-4613-81ef-42d4a23bca01',
      inventoryUnitCode: 'KING',
      checkInDate: '2026-12-01',
      checkOutDate: '2026-12-05',
      unitsBooked: 1,
      guestName: 'John Connor',
      totalPriceCents: 50000,
      currency: 'USD',
      status: 'CONFIRMED' as any,
    });

    const mockReq = { rawBody: Buffer.from(rawBody) } as any;
    await controller.handleIncomingWebhook('partner_c', {}, mockReq);

    expect(mockIdempotencyService.acquireOrReplay).toHaveBeenCalledWith(
      `partner_c:${expectedHash}`,
      'WEBHOOK:PARTNER_C',
      30,
    );
  });

  it('validates normalized payload with Zod canonical schema and throws 422 if invalid', async () => {
    const rawBody = JSON.stringify({ property_id: 'EXT-PROP-1' });

    mockAdaptor.verifyWebhook.mockResolvedValueOnce({
      isValid: true,
      idempotencyKey: 'evt-1',
      parsedBody: { property_id: 'EXT-PROP-1' },
    });

    (prisma.partner.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({ id: 'part-1', slug: 'partner_c' });
    (prisma.propertyPartnerMapping.findFirst as jest.Mock).mockResolvedValueOnce({ propertyId: 'c9f0b188-39dc-4613-81ef-42d4a23bca01' });

    // Returns invalid payload missing required fields according to CanonicalReservationSchema
    mockAdaptor.transformInboundReservation.mockResolvedValueOnce({
      externalBookingId: '', // Invalid: min(1) violated
      propertyId: 'not-a-uuid', // Invalid: uuid() violated
      inventoryUnitCode: 'KING',
      checkInDate: 'invalid-date-format', // Invalid: YYYY-MM-DD violated
      status: 'INVALID_STATUS' as any,
    } as any);

    const mockReq = { rawBody: Buffer.from(rawBody) } as any;

    await expect(
      controller.handleIncomingWebhook('partner_c', {}, mockReq),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(mockStateMachine.processTransition).not.toHaveBeenCalled();
  });
});
