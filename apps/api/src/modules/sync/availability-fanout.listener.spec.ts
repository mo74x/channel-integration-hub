import { EventEmitter } from 'node:events';
import { AvailabilityFanoutListener } from './availability-fanout.listener.js';
import { SyncService } from './sync.service.js';
import { prisma } from '@cih/database';
import {
  RESERVATION_INVENTORY_CHANGED_EVENT,
  ReservationInventoryChangedEvent,
} from '../reservations/reservation-state-machine.service.js';

jest.mock('@cih/database', () => ({
  prisma: {
    inventoryCalendar: {
      findMany: jest.fn(),
    },
    inventoryUnit: {
      findUnique: jest.fn(),
    },
  },
}));

describe('AvailabilityFanoutListener', () => {
  let listener: AvailabilityFanoutListener;
  let mockSyncService: jest.Mocked<Partial<SyncService>>;
  let eventEmitter: EventEmitter;

  const mockCalendarRows = [
    {
      id: 'cal-1',
      inventoryUnitId: 'unit-uuid-1',
      date: new Date('2026-11-10T00:00:00.000Z'),
      availableUnits: 2,
      priceInCents: 15000,
      inventoryUnit: {
        id: 'unit-uuid-1',
        propertyId: 'prop-uuid-1',
        externalCode: 'DELUXE_KING',
      },
    },
    {
      id: 'cal-2',
      inventoryUnitId: 'unit-uuid-1',
      date: new Date('2026-11-11T00:00:00.000Z'),
      availableUnits: 2,
      priceInCents: 15000,
      inventoryUnit: {
        id: 'unit-uuid-1',
        propertyId: 'prop-uuid-1',
        externalCode: 'DELUXE_KING',
      },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    eventEmitter = new EventEmitter();
    mockSyncService = {
      broadcastInventoryUpdate: jest.fn().mockResolvedValue(undefined),
    };

    listener = new AvailabilityFanoutListener(
      mockSyncService as SyncService,
      eventEmitter,
    );
  });

  describe('Lifecycle subscription', () => {
    it('should subscribe onModuleInit and unsubscribe onModuleDestroy', () => {
      expect(eventEmitter.listenerCount(RESERVATION_INVENTORY_CHANGED_EVENT)).toBe(0);

      listener.onModuleInit();
      expect(eventEmitter.listenerCount(RESERVATION_INVENTORY_CHANGED_EVENT)).toBe(1);

      listener.onModuleDestroy();
      expect(eventEmitter.listenerCount(RESERVATION_INVENTORY_CHANGED_EVENT)).toBe(0);
    });
  });

  describe('Core Fan-Out Loop: Confirm booking', () => {
    it('should read updated calendar rows and broadcast to other partners, skipping booking partner', async () => {
      (prisma.inventoryCalendar.findMany as jest.Mock).mockResolvedValue(mockCalendarRows);

      const event: ReservationInventoryChangedEvent = {
        reservationId: 'res-101',
        partnerId: 'partner-uuid-a',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        action: 'CONFIRMED',
        unitsBooked: 1,
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
      };

      await listener.handleInventoryChanged(event);

      // Verify database calendar rows queried for the stay dates
      expect(prisma.inventoryCalendar.findMany).toHaveBeenCalledWith({
        where: {
          inventoryUnitId: 'unit-uuid-1',
          date: {
            gte: new Date('2026-11-10T00:00:00.000Z'),
            lt: new Date('2026-11-12T00:00:00.000Z'),
          },
        },
        include: { inventoryUnit: true },
        orderBy: { date: 'asc' },
      });

      // Verify broadcast called for both dates, skipping partner-uuid-a (no echo)
      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenCalledTimes(2);

      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenNthCalledWith(
        1,
        {
          propertyId: 'prop-uuid-1',
          inventoryUnitCode: 'DELUXE_KING',
          date: '2026-11-10',
          availableUnits: 2,
          priceInCents: 15000,
        },
        'partner-uuid-a',
      );

      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenNthCalledWith(
        2,
        {
          propertyId: 'prop-uuid-1',
          inventoryUnitCode: 'DELUXE_KING',
          date: '2026-11-11',
          availableUnits: 2,
          priceInCents: 15000,
        },
        'partner-uuid-a',
      );
    });
  });

  describe('Core Fan-Out Loop: Cancel booking', () => {
    it('should fan out restored calendar rows when a booking is cancelled', async () => {
      const restoredCalendarRows = mockCalendarRows.map((r) => ({
        ...r,
        availableUnits: 3, // Capacity restored
      }));
      (prisma.inventoryCalendar.findMany as jest.Mock).mockResolvedValue(restoredCalendarRows);

      const cancelEvent: ReservationInventoryChangedEvent = {
        reservationId: 'res-101',
        partnerId: 'partner-uuid-b',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        action: 'CANCELLED',
        unitsBooked: 1,
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
      };

      await listener.handleInventoryChanged(cancelEvent);

      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenCalledTimes(2);
      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          availableUnits: 3,
          date: '2026-11-10',
        }),
        'partner-uuid-b',
      );
    });
  });

  describe('Event trigger via EventEmitter', () => {
    it('should react to domain event emitted by event emitter', async () => {
      (prisma.inventoryCalendar.findMany as jest.Mock).mockResolvedValue([mockCalendarRows[0]]);
      listener.onModuleInit();

      eventEmitter.emit(RESERVATION_INVENTORY_CHANGED_EVENT, {
        reservationId: 'res-202',
        partnerId: 'partner-uuid-c',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        action: 'CONFIRMED',
        unitsBooked: 1,
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-11',
      });

      // Allow event loop tick for async handler
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSyncService.broadcastInventoryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          date: '2026-11-10',
          availableUnits: 2,
        }),
        'partner-uuid-c',
      );

      listener.onModuleDestroy();
    });
  });

  describe('Edge cases and error handling', () => {
    it('should gracefully handle empty calendar rows without errors', async () => {
      (prisma.inventoryCalendar.findMany as jest.Mock).mockResolvedValue([]);

      await listener.handleInventoryChanged({
        reservationId: 'res-empty',
        partnerId: 'partner-uuid-a',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        action: 'CONFIRMED',
        unitsBooked: 1,
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-11',
      });

      expect(mockSyncService.broadcastInventoryUpdate).not.toHaveBeenCalled();
    });

    it('should ignore malformed events', async () => {
      await listener.handleInventoryChanged({} as any);
      expect(prisma.inventoryCalendar.findMany).not.toHaveBeenCalled();
      expect(mockSyncService.broadcastInventoryUpdate).not.toHaveBeenCalled();
    });
  });
});
