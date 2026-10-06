import { PollingProcessor } from './polling.processor.js';
import { PartnerAdaptor } from '../../adaptors/partner-adaptor.interface.js';
import { ReservationStateMachineService } from '../../reservations/reservation-state-machine.service.js';
import { prisma, SyncJobType, SyncJobStatus } from '@cih/database';

jest.mock('@cih/database', () => ({
  prisma: {
    partner: {
      findUnique: jest.fn(),
    },
    propertyPartnerMapping: {
      findMany: jest.fn(),
    },
    syncJob: {
      create: jest.fn(),
    },
  },
  SyncJobType: {
    SCHEDULED_POLL: 'SCHEDULED_POLL',
  },
  SyncJobStatus: {
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
  },
}));

describe('PollingProcessor', () => {
  let processor: PollingProcessor;
  let mockStateMachine: jest.Mocked<ReservationStateMachineService>;
  let adaptorA: jest.Mocked<PartnerAdaptor>;
  let adaptorB: jest.Mocked<PartnerAdaptor>;
  let adaptorsMap: Map<string, PartnerAdaptor>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStateMachine = {
      processTransition: jest.fn().mockResolvedValue({ id: 'res-1' }),
    } as unknown as jest.Mocked<ReservationStateMachineService>;

    // Partner A only does webhooks (not polling)
    adaptorA = {
      partnerSlug: 'partner_a',
      capabilities: { webhooks: true, polling: false, inventoryPush: true },
      pullReservations: jest.fn(),
    } as unknown as jest.Mocked<PartnerAdaptor>;

    // Partner B supports polling
    adaptorB = {
      partnerSlug: 'partner_b',
      capabilities: { webhooks: false, polling: true, inventoryPush: false },
      pullReservations: jest.fn().mockResolvedValue([
        {
          externalBookingId: 'BOOK-B-1',
          status: 'CONFIRMED',
          inventoryUnitCode: 'KING_ROOM',
          checkInDate: '2026-11-01',
          checkOutDate: '2026-11-05',
          unitsBooked: 1,
          guestName: 'John Doe',
          guestEmail: 'john@example.com',
          totalPriceCents: 45000,
          currency: 'USD',
          metadata: {},
        },
      ]),
    } as unknown as jest.Mocked<PartnerAdaptor>;

    adaptorsMap = new Map([
      ['partner_a', adaptorA],
      ['partner_b', adaptorB],
    ]);

    processor = new PollingProcessor(adaptorsMap, mockStateMachine);
  });

  it('only loops over partners with polling capability, skipping incapable partners', async () => {
    (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
      id: 'partner-uuid-b',
      slug: 'partner_b',
      name: 'Partner B Channel',
      status: 'ACTIVE',
    });

    (prisma.propertyPartnerMapping.findMany as jest.Mock).mockResolvedValue([
      {
        partnerId: 'partner-uuid-b',
        propertyId: 'prop-internal-1',
        externalPropertyId: 'EXT-PROP-101',
      },
    ]);

    await processor.process();

    // Partner A should NEVER have pullReservations called
    expect(adaptorA.pullReservations).not.toHaveBeenCalled();

    // Partner B was polled
    expect(adaptorB.pullReservations).toHaveBeenCalledWith('EXT-PROP-101', expect.any(Date));
    expect(mockStateMachine.processTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerId: 'partner-uuid-b',
        externalBookingId: 'BOOK-B-1',
      }),
    );
    expect(prisma.syncJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          partnerId: 'partner-uuid-b',
          status: SyncJobStatus.COMPLETED,
        }),
      }),
    );
  });
});
