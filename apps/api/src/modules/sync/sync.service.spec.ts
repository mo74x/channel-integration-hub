import { SyncService } from './sync.service.js';
import { prisma, 
  
 } from '@cih/database';
import { Queue } from 'bullmq';
import { SYNC_JOBS } from './sync.constants.js';

jest.mock('@cih/database', () => ({
  prisma: {
    partner: {
      findMany: jest.fn(),
    },
    syncJob: {
      create: jest.fn(),
    },
  },
  SyncJobType: {
    OUTBOUND_PUSH: 'OUTBOUND_PUSH',
  },
}));

describe('SyncService - broadcastInventoryUpdate', () => {
  let service: SyncService;
  let mockQueue: jest.Mocked<Partial<Queue>>;

  const dummyPayload = {
    propertyId: 'prop-1',
    inventoryUnitCode: 'DELUXE_KING',
    date: '2026-11-10',
    availableUnits: 3,
    priceInCents: 15000,
  };

  const activePartners = [
    { id: 'partner-uuid-a', slug: 'partner_a', status: 'ACTIVE' },
    { id: 'partner-uuid-b', slug: 'partner_b', status: 'ACTIVE' },
    { id: 'partner-uuid-c', slug: 'partner_c', status: 'ACTIVE' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bull-job-1' } as any),
    };
    service = new SyncService(mockQueue as Queue);
    (prisma.partner.findMany as jest.Mock).mockResolvedValue(activePartners);
    (prisma.syncJob.create as jest.Mock).mockImplementation(async ({ data }) => ({
      id: `sync-rec-${data.partnerId}`,
      ...data,
    }));
  });

  it('should broadcast inventory update to all active partners when no skipPartnerId is specified', async () => {
    await service.broadcastInventoryUpdate(dummyPayload);

    expect(prisma.partner.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
    });

    expect(prisma.syncJob.create).toHaveBeenCalledTimes(3);
    expect(mockQueue.add).toHaveBeenCalledTimes(3);

    expect(mockQueue.add).toHaveBeenCalledWith(
      SYNC_JOBS.PUSH_INVENTORY_SLOT,
      expect.objectContaining({
        partnerSlug: 'partner_a',
        update: dummyPayload,
      }),
      expect.objectContaining({ attempts: 5 }),
    );
    expect(mockQueue.add).toHaveBeenCalledWith(
      SYNC_JOBS.PUSH_INVENTORY_SLOT,
      expect.objectContaining({
        partnerSlug: 'partner_b',
        update: dummyPayload,
      }),
      expect.objectContaining({ attempts: 5 }),
    );
    expect(mockQueue.add).toHaveBeenCalledWith(
      SYNC_JOBS.PUSH_INVENTORY_SLOT,
      expect.objectContaining({
        partnerSlug: 'partner_c',
        update: dummyPayload,
      }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it('should skip the originating partner by partnerId to prevent echo updates', async () => {
    // Partner A sent the booking, so Partner A must not receive an inventory update
    (prisma.partner.findMany as jest.Mock).mockResolvedValue([
      { id: 'partner-uuid-b', slug: 'partner_b', status: 'ACTIVE' },
      { id: 'partner-uuid-c', slug: 'partner_c', status: 'ACTIVE' },
    ]);

    await service.broadcastInventoryUpdate(dummyPayload, 'partner-uuid-a');

    expect(prisma.syncJob.create).toHaveBeenCalledTimes(2);
    expect(mockQueue.add).toHaveBeenCalledTimes(2);

    const queuedSlugs = (mockQueue.add as jest.Mock).mock.calls.map(
      (call) => call[1].partnerSlug,
    );
    expect(queuedSlugs).toEqual(['partner_b', 'partner_c']);
    expect(queuedSlugs).not.toContain('partner_a');
  });

  it('should skip the originating partner when passed as partner slug', async () => {
    (prisma.partner.findMany as jest.Mock).mockResolvedValue(activePartners);

    await service.broadcastInventoryUpdate(dummyPayload, 'partner_b');

    const queuedSlugs = (mockQueue.add as jest.Mock).mock.calls.map(
      (call) => call[1].partnerSlug,
    );
    expect(queuedSlugs).toEqual(['partner_a', 'partner_c']);
    expect(queuedSlugs).not.toContain('partner_b');
  });

  it('should support options object with skipPartnerId', async () => {
    (prisma.partner.findMany as jest.Mock).mockResolvedValue(activePartners);

    await service.broadcastInventoryUpdate(dummyPayload, { skipPartnerId: 'partner-uuid-c' });

    const queuedSlugs = (mockQueue.add as jest.Mock).mock.calls.map(
      (call) => call[1].partnerSlug,
    );
    expect(queuedSlugs).toEqual(['partner_a', 'partner_b']);
    expect(queuedSlugs).not.toContain('partner_c');
  });
});
