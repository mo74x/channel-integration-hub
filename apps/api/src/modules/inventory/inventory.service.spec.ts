import { InventoryService } from './inventory.service.js';
import { DistributedLockService } from '../../common/redis/distributed-lock.service.js';
import { prisma } from '@cih/database';

jest.mock('@cih/database', () => ({
  prisma: {
    inventoryUnit: {
      findUnique: jest.fn(),
    },
    inventoryCalendar: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(async (callback) => {
      return await callback(prisma);
    }),
  },
}));

describe('InventoryService', () => {
  let service: InventoryService;
  let mockLockService: jest.Mocked<DistributedLockService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLockService = {
      acquireLock: jest.fn().mockImplementation(async (key: string) => ({
        key,
        token: `token-${key}`,
      })),
      releaseLock: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<DistributedLockService>;

    service = new InventoryService(mockLockService);
  });

  describe('restoreInventoryUnits', () => {
    it('acquires sorted per-date distributed locks and releases them in reverse order', async () => {
      (prisma.inventoryCalendar.update as jest.Mock).mockResolvedValue({ id: 'cal-1' });

      await service.restoreInventoryUnits(
        'unit-uuid-1',
        '2026-11-10',
        '2026-11-12',
        2,
      );

      // Lock keys should be sorted lexicographically
      expect(mockLockService.acquireLock).toHaveBeenCalledTimes(2);
      expect(mockLockService.acquireLock).toHaveBeenNthCalledWith(
        1,
        'inventory:unit-uuid-1:2026-11-10',
        8000,
        12,
        100,
      );
      expect(mockLockService.acquireLock).toHaveBeenNthCalledWith(
        2,
        'inventory:unit-uuid-1:2026-11-11',
        8000,
        12,
        100,
      );

      // Verify release in reverse order
      expect(mockLockService.releaseLock).toHaveBeenCalledTimes(2);
      expect(mockLockService.releaseLock).toHaveBeenNthCalledWith(1, {
        key: 'inventory:unit-uuid-1:2026-11-11',
        token: 'token-inventory:unit-uuid-1:2026-11-11',
      });
      expect(mockLockService.releaseLock).toHaveBeenNthCalledWith(2, {
        key: 'inventory:unit-uuid-1:2026-11-10',
        token: 'token-inventory:unit-uuid-1:2026-11-10',
      });

      // Verify calendar increment
      expect(prisma.inventoryCalendar.update).toHaveBeenCalledTimes(2);
      expect(prisma.inventoryCalendar.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            availableUnits: { increment: 2 },
            version: { increment: 1 },
          },
        }),
      );
    });
  });

  describe('bookInventoryUnits', () => {
    it('acquires sorted per-date distributed locks and decrements available units', async () => {
      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
        propertyId: 'prop-1',
        externalCode: 'KING',
      });

      (prisma.inventoryCalendar.findUnique as jest.Mock).mockResolvedValue({
        id: 'cal-1',
        availableUnits: 5,
        priceInCents: 25000,
      });

      (prisma.inventoryCalendar.update as jest.Mock).mockResolvedValue({ id: 'cal-1' });

      const result = await service.bookInventoryUnits(
        'prop-1',
        'KING',
        '2026-11-10',
        '2026-11-12',
        1,
      );

      expect(result.success).toBe(true);
      expect(result.totalPriceCents).toBe(50000); // 2 nights * 25000
      expect(mockLockService.acquireLock).toHaveBeenCalledTimes(2);
      expect(mockLockService.releaseLock).toHaveBeenCalledTimes(2);
    });
  });
});
