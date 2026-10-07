import { NotFoundException, BadRequestException } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { DistributedLockService } from '../../common/redis/distributed-lock.service.js';
import { SyncService } from '../sync/sync.service.js';
import { prisma } from '@cih/database';

jest.mock('@cih/database', () => ({
  prisma: {
    property: {
      findUnique: jest.fn(),
    },
    inventoryUnit: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    inventoryCalendar: {
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(async (callback) => {
      return await callback(prisma);
    }),
  },
}));

describe('InventoryService', () => {
  let service: InventoryService;
  let mockLockService: jest.Mocked<DistributedLockService>;
  let mockSyncService: jest.Mocked<Partial<SyncService>>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLockService = {
      acquireLock: jest.fn().mockImplementation(async (key: string) => ({
        key,
        token: `token-${key}`,
      })),
      releaseLock: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<DistributedLockService>;

    mockSyncService = {
      broadcastInventoryUpdate: jest.fn().mockResolvedValue(undefined),
    };

    service = new InventoryService(mockLockService, mockSyncService as SyncService);
  });

  describe('Date range validation', () => {
    it('throws BadRequestException when check-out date is on or before check-in date in bookInventoryUnits', async () => {
      await expect(
        service.bookInventoryUnits('prop-1', 'KING', '2026-11-15', '2026-11-15', 1),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.bookInventoryUnits('prop-1', 'KING', '2026-11-15', '2026-11-10', 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when check-out date is on or before check-in date in restoreInventoryUnits', async () => {
      await expect(
        service.restoreInventoryUnits('unit-1', '2026-11-15', '2026-11-15', 1),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Insufficient inventory & uninitialized dates', () => {
    it('throws BadRequestException when availableUnits is less than unitsToBook', async () => {
      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
        propertyId: 'prop-1',
        externalCode: 'KING',
      });

      (prisma.inventoryCalendar.findUnique as jest.Mock).mockResolvedValue({
        id: 'cal-1',
        availableUnits: 1, // Only 1 available
        priceInCents: 20000,
      });

      await expect(
        service.bookInventoryUnits('prop-1', 'KING', '2026-11-10', '2026-11-11', 2), // Requesting 2
      ).rejects.toThrow(/Insufficient inventory on 2026-11-10: requested 2, available 1/);
    });

    it('throws BadRequestException when calendar is uninitialized for a date in range', async () => {
      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
        propertyId: 'prop-1',
        externalCode: 'KING',
      });

      (prisma.inventoryCalendar.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.bookInventoryUnits('prop-1', 'KING', '2026-11-10', '2026-11-11', 1),
      ).rejects.toThrow(/Inventory uninitialized for date 2026-11-10/);
    });
  });

  describe('Lock ordering & lock release on error', () => {
    it('acquires locks in lexicographical order and releases them in reverse order', async () => {
      (prisma.inventoryCalendar.update as jest.Mock).mockResolvedValue({ id: 'cal-1' });

      await service.restoreInventoryUnits(
        'unit-uuid-1',
        '2026-11-10',
        '2026-11-13',
        1,
      );

      // Verify lexicographical order
      expect(mockLockService.acquireLock).toHaveBeenCalledTimes(3);
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
      expect(mockLockService.acquireLock).toHaveBeenNthCalledWith(
        3,
        'inventory:unit-uuid-1:2026-11-12',
        8000,
        12,
        100,
      );

      // Verify reverse order release
      expect(mockLockService.releaseLock).toHaveBeenCalledTimes(3);
      expect(mockLockService.releaseLock).toHaveBeenNthCalledWith(1, {
        key: 'inventory:unit-uuid-1:2026-11-12',
        token: 'token-inventory:unit-uuid-1:2026-11-12',
      });
      expect(mockLockService.releaseLock).toHaveBeenNthCalledWith(2, {
        key: 'inventory:unit-uuid-1:2026-11-11',
        token: 'token-inventory:unit-uuid-1:2026-11-11',
      });
      expect(mockLockService.releaseLock).toHaveBeenNthCalledWith(3, {
        key: 'inventory:unit-uuid-1:2026-11-10',
        token: 'token-inventory:unit-uuid-1:2026-11-10',
      });
    });

    it('guarantees acquired locks are released when transaction fails with an error', async () => {
      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
        propertyId: 'prop-1',
        externalCode: 'KING',
      });

      // Fail during transaction
      (prisma.inventoryCalendar.findUnique as jest.Mock).mockRejectedValueOnce(
        new Error('Database deadlock simulation'),
      );

      await expect(
        service.bookInventoryUnits('prop-1', 'KING', '2026-11-10', '2026-11-12', 1),
      ).rejects.toThrow('Database deadlock simulation');

      // Both locks were acquired before transaction failure, and MUST be released in finally block
      expect(mockLockService.acquireLock).toHaveBeenCalledTimes(2);
      expect(mockLockService.releaseLock).toHaveBeenCalledTimes(2);
    });

    it('throws BadRequestException when lock acquisition times out', async () => {
      mockLockService.acquireLock.mockResolvedValueOnce(null);

      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
        propertyId: 'prop-1',
        externalCode: 'KING',
      });

      await expect(
        service.bookInventoryUnits('prop-1', 'KING', '2026-11-10', '2026-11-12', 1),
      ).rejects.toThrow(/Concurrency timeout while locking inventory/);
    });
  });

  describe('getAvailability', () => {
    it('should throw NotFoundException if property does not exist', async () => {
      (prisma.property.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getAvailability('unknown-prop', '2026-11-10', '2026-11-12'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if dates are invalid or from > to', async () => {
      await expect(
        service.getAvailability('prop-1', '2026-11-15', '2026-11-10'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return units with calendar availability', async () => {
      (prisma.property.findUnique as jest.Mock).mockResolvedValue({
        id: 'prop-1',
        name: 'Grand Hotel',
        currency: 'USD',
        timezone: 'UTC',
      });

      (prisma.inventoryUnit.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'unit-1',
          externalCode: 'DELUXE_KING',
          name: 'Deluxe King',
          totalUnits: 10,
          calendar: [
            {
              date: new Date('2026-11-10T00:00:00.000Z'),
              availableUnits: 4,
              priceInCents: 20000,
            },
          ],
        },
      ]);

      const res = await service.getAvailability('prop-1', '2026-11-10', '2026-11-12');

      expect(res.propertyId).toBe('prop-1');
      expect(res.units).toHaveLength(1);
      expect(res.units[0].code).toBe('DELUXE_KING');
      expect(res.units[0].calendar[0].availableUnits).toBe(4);
      expect(res.units[0].calendar[0].isAvailable).toBe(true);
    });
  });

  describe('bulkUpdateCalendar', () => {
    it('should throw NotFoundException if inventory unit does not exist', async () => {
      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.bulkUpdateCalendar('prop-1', 'UNKNOWN_UNIT', [
          { date: '2026-11-10', availableUnits: 5, priceInCents: 15000 },
        ]),
      ).rejects.toThrow(NotFoundException);
    });

    it('should upsert calendar records and trigger fan-out across partners', async () => {
      (prisma.inventoryUnit.findUnique as jest.Mock).mockResolvedValue({
        id: 'unit-1',
        propertyId: 'prop-1',
        externalCode: 'DELUXE_KING',
        totalUnits: 10,
      });

      (prisma.inventoryCalendar.upsert as jest.Mock).mockImplementation(async ({ create }) => ({
        id: `cal-${create.date.toISOString().slice(0, 10)}`,
        ...create,
      }));

      const entries = [
        { date: '2026-11-10', availableUnits: 4, priceInCents: 18000 },
        { date: '2026-11-11', availableUnits: 4, priceInCents: 18000 },
      ];

      const res = await service.bulkUpdateCalendar('prop-1', 'DELUXE_KING', entries);

      expect(res.success).toBe(true);
      expect(res.updatedCount).toBe(2);
      expect(res.fanoutTriggered).toBe(true);
      expect(mockLockService.acquireLock).toHaveBeenCalledTimes(2);
      expect(prisma.inventoryCalendar.upsert).toHaveBeenCalledTimes(2);
      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenCalledTimes(2);
    });
  });
});
