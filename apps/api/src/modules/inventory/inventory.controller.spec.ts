import { BadRequestException } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

describe('InventoryController', () => {
  let controller: InventoryController;
  let mockInventoryService: jest.Mocked<Partial<InventoryService>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockInventoryService = {
      getAvailability: jest.fn().mockResolvedValue({
        propertyId: 'prop-1',
        from: '2026-11-10',
        to: '2026-11-12',
        units: [],
      } as any),
      bulkUpdateCalendar: jest.fn().mockResolvedValue({
        success: true,
        propertyId: 'prop-1',
        inventoryUnitCode: 'DELUXE_KING',
        updatedCount: 2,
        fanoutTriggered: true,
        entries: [],
      } as any),
    };

    controller = new InventoryController(mockInventoryService as InventoryService);
  });

  describe('GET :propertyId/availability', () => {
    it('should throw BadRequestException if "from" or "to" query param is missing', async () => {
      await expect(
        controller.getAvailability('prop-1', '', '2026-11-12'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.getAvailability('prop-1', '2026-11-10', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('should call inventoryService.getAvailability and return the result', async () => {
      const res = await controller.getAvailability(
        'prop-1',
        '2026-11-10',
        '2026-11-12',
        'DELUXE_KING',
      );

      expect(mockInventoryService.getAvailability).toHaveBeenCalledWith(
        'prop-1',
        '2026-11-10',
        '2026-11-12',
        'DELUXE_KING',
      );
      expect(res.propertyId).toBe('prop-1');
    });
  });

  describe('PUT :propertyId/units/:code/calendar', () => {
    it('should throw BadRequestException if body is not an array and lacks entries', async () => {
      await expect(
        controller.bulkUpdateCalendar('prop-1', 'DELUXE_KING', null),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.bulkUpdateCalendar('prop-1', 'DELUXE_KING', []),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.bulkUpdateCalendar('prop-1', 'DELUXE_KING', { entries: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept direct array body and call bulkUpdateCalendar', async () => {
      const entries = [
        { date: '2026-11-10', availableUnits: 5, priceInCents: 15000 },
        { date: '2026-11-11', availableUnits: 5, priceInCents: 15000 },
      ];

      const res = await controller.bulkUpdateCalendar('prop-1', 'DELUXE_KING', entries);

      expect(mockInventoryService.bulkUpdateCalendar).toHaveBeenCalledWith(
        'prop-1',
        'DELUXE_KING',
        entries,
      );
      expect(res.success).toBe(true);
      expect(res.fanoutTriggered).toBe(true);
    });

    it('should accept object wrapper { entries: [...] } and call bulkUpdateCalendar', async () => {
      const entries = [
        { date: '2026-11-10', availableUnits: 3, priceInCents: 12000 },
      ];

      const res = await controller.bulkUpdateCalendar('prop-1', 'DELUXE_KING', { entries });

      expect(mockInventoryService.bulkUpdateCalendar).toHaveBeenCalledWith(
        'prop-1',
        'DELUXE_KING',
        entries,
      );
      expect(res.success).toBe(true);
    });
  });
});
