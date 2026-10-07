import { BadRequestException } from '@nestjs/common';
import { ReservationStatus } from '@cih/shared';
import { ReservationStateMachineService } from './reservation-state-machine.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { prisma } from '@cih/database';

jest.mock('@cih/database', () => ({
  prisma: {
    reservation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    inventoryUnit: {
      findUniqueOrThrow: jest.fn(),
    },
  },
}));

describe('ReservationStateMachineService', () => {
  let service: ReservationStateMachineService;
  let mockInventoryService: Partial<InventoryService>;
  let mockEvents: { emit: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockInventoryService = {
      bookInventoryUnits: jest.fn().mockResolvedValue({
        success: true,
        totalPriceCents: 50000,
        inventoryUnitId: 'unit-uuid-1',
      }),
      restoreInventoryUnits: jest.fn().mockResolvedValue(undefined),
    };
    mockEvents = { emit: jest.fn() };
    service = new ReservationStateMachineService(
      mockInventoryService as InventoryService,
      mockEvents as any,
    );
  });

  describe('New reservation creation', () => {
    it('creates CONFIRMED reservation directly and allocates inventory', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.reservation.create as jest.Mock).mockResolvedValue({
        id: 'res-101',
        partnerId: 'partner-uuid-1',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        status: 'CONFIRMED',
        unitsBooked: 1,
      });

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-99',
        targetStatus: ReservationStatus.CONFIRMED,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 1,
        guestName: 'Jane Doe',
      });

      expect(mockInventoryService.bookInventoryUnits).toHaveBeenCalledWith(
        'prop-uuid-1',
        'DELUXE_KING',
        '2026-11-10',
        '2026-11-12',
        1,
      );
      expect(result.status).toBe('CONFIRMED');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'reservation.inventory-changed',
        expect.objectContaining({ action: 'CONFIRMED' }),
      );
    });

    it('creates PENDING reservation without allocating inventory', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inventoryUnit.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
      });
      (prisma.reservation.create as jest.Mock).mockResolvedValue({
        id: 'res-pending',
        status: 'PENDING',
      });

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-PEND',
        targetStatus: ReservationStatus.PENDING,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 1,
        guestName: 'Jane Doe',
      });

      expect(mockInventoryService.bookInventoryUnits).not.toHaveBeenCalled();
      expect(result.status).toBe('PENDING');
    });

    it('creates REJECTED reservation without allocating inventory', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inventoryUnit.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        id: 'unit-uuid-1',
      });
      (prisma.reservation.create as jest.Mock).mockResolvedValue({
        id: 'res-rejected',
        status: 'REJECTED',
      });

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-REJ-INIT',
        targetStatus: ReservationStatus.REJECTED,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 1,
        guestName: 'Jane Doe',
      });

      expect(mockInventoryService.bookInventoryUnits).not.toHaveBeenCalled();
      expect(result.status).toBe('REJECTED');
    });
  });

  describe('PENDING -> CONFIRMED & Compensation', () => {
    it('transitions existing PENDING to CONFIRMED and allocates inventory', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-pend-1',
        partnerId: 'partner-uuid-1',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        status: 'PENDING',
        checkInDate: new Date('2026-11-10'),
        checkOutDate: new Date('2026-11-12'),
        unitsBooked: 2,
        rawPayload: {},
      });

      (prisma.reservation.update as jest.Mock).mockResolvedValue({
        id: 'res-pend-1',
        partnerId: 'partner-uuid-1',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        status: 'CONFIRMED',
        unitsBooked: 2,
      });

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-P1',
        targetStatus: ReservationStatus.CONFIRMED,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 2,
        guestName: 'John Doe',
      });

      expect(mockInventoryService.bookInventoryUnits).toHaveBeenCalledWith(
        'prop-uuid-1',
        'DELUXE_KING',
        '2026-11-10',
        '2026-11-12',
        2,
      );
      expect(result.status).toBe('CONFIRMED');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'reservation.inventory-changed',
        expect.objectContaining({ action: 'CONFIRMED' }),
      );
    });

    it('compensates and restores inventory when reservation.update fails during PENDING -> CONFIRMED', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-pend-fail',
        partnerId: 'partner-uuid-1',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        status: 'PENDING',
        checkInDate: new Date('2026-11-10'),
        checkOutDate: new Date('2026-11-12'),
        unitsBooked: 1,
        rawPayload: {},
      });

      (prisma.reservation.update as jest.Mock).mockRejectedValueOnce(
        new Error('Optimistic concurrency conflict'),
      );

      await expect(
        service.processTransition({
          partnerId: 'partner-uuid-1',
          externalBookingId: 'BOOK-PFAIL',
          targetStatus: ReservationStatus.CONFIRMED,
          propertyId: 'prop-uuid-1',
          inventoryUnitCode: 'DELUXE_KING',
          checkInDate: '2026-11-10',
          checkOutDate: '2026-11-12',
          unitsBooked: 1,
          guestName: 'John Doe',
        }),
      ).rejects.toThrow('Optimistic concurrency conflict');

      // Verify compensation restored inventory
      expect(mockInventoryService.restoreInventoryUnits).toHaveBeenCalledWith(
        'unit-uuid-1',
        '2026-11-10',
        '2026-11-12',
        1,
      );
    });

    it('compensates and restores inventory when initial reservation creation fails', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.reservation.create as jest.Mock).mockRejectedValue(new Error('DB Constraint Violation'));

      await expect(
        service.processTransition({
          partnerId: 'partner-uuid-1',
          externalBookingId: 'BOOK-FAIL',
          targetStatus: ReservationStatus.CONFIRMED,
          propertyId: 'prop-uuid-1',
          inventoryUnitCode: 'DELUXE_KING',
          checkInDate: '2026-11-10',
          checkOutDate: '2026-11-12',
          unitsBooked: 1,
          guestName: 'Jane Doe',
        }),
      ).rejects.toThrow('DB Constraint Violation');

      expect(mockInventoryService.bookInventoryUnits).toHaveBeenCalled();
      expect(mockInventoryService.restoreInventoryUnits).toHaveBeenCalledWith(
        'unit-uuid-1',
        '2026-11-10',
        '2026-11-12',
        1,
      );
    });
  });

  describe('PENDING -> REJECTED & Terminal states', () => {
    it('transitions PENDING to REJECTED without modifying inventory', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-pend-2',
        status: 'PENDING',
        rawPayload: {},
      });

      (prisma.reservation.update as jest.Mock).mockResolvedValue({
        id: 'res-pend-2',
        status: 'REJECTED',
      });

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-REJ',
        targetStatus: ReservationStatus.REJECTED,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 1,
        guestName: 'Jane Doe',
      });

      expect(mockInventoryService.bookInventoryUnits).not.toHaveBeenCalled();
      expect(mockInventoryService.restoreInventoryUnits).not.toHaveBeenCalled();
      expect(result.status).toBe('REJECTED');
    });

    it('rejects any transition from REJECTED state (terminal state)', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-rej',
        status: 'REJECTED',
      });

      await expect(
        service.processTransition({
          partnerId: 'partner-uuid-1',
          externalBookingId: 'BOOK-REJ',
          targetStatus: ReservationStatus.CONFIRMED,
          propertyId: 'prop-uuid-1',
          inventoryUnitCode: 'DELUXE_KING',
          checkInDate: '2026-11-10',
          checkOutDate: '2026-11-12',
          unitsBooked: 1,
          guestName: 'Jane Doe',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects any transition from CANCELLED state (terminal state)', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-canc',
        status: 'CANCELLED',
      });

      await expect(
        service.processTransition({
          partnerId: 'partner-uuid-1',
          externalBookingId: 'BOOK-CANC',
          targetStatus: ReservationStatus.CONFIRMED,
          propertyId: 'prop-uuid-1',
          inventoryUnitCode: 'DELUXE_KING',
          checkInDate: '2026-11-10',
          checkOutDate: '2026-11-12',
          unitsBooked: 1,
          guestName: 'Jane Doe',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('CONFIRMED -> CANCELLED', () => {
    it('restores inventory capacity and emits domain event', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-conf',
        partnerId: 'partner-uuid-1',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        status: 'CONFIRMED',
        checkInDate: new Date('2026-11-10'),
        checkOutDate: new Date('2026-11-12'),
        unitsBooked: 2,
        rawPayload: {},
      });

      (prisma.reservation.update as jest.Mock).mockResolvedValue({
        id: 'res-conf',
        partnerId: 'partner-uuid-1',
        propertyId: 'prop-uuid-1',
        inventoryUnitId: 'unit-uuid-1',
        status: 'CANCELLED',
        unitsBooked: 2,
      });

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-CONF',
        targetStatus: ReservationStatus.CANCELLED,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 2,
        guestName: 'Jane Doe',
      });

      expect(mockInventoryService.restoreInventoryUnits).toHaveBeenCalledWith(
        'unit-uuid-1',
        '2026-11-10',
        '2026-11-12',
        2,
      );
      expect(result.status).toBe('CANCELLED');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'reservation.inventory-changed',
        expect.objectContaining({ action: 'CANCELLED' }),
      );
    });
  });

  describe('Idempotency no-op', () => {
    it('treats identical status transition as idempotent no-op without re-allocating', async () => {
      const existingRecord = { id: 'res-same', status: 'CONFIRMED' };
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(existingRecord);

      const result = await service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-SAME',
        targetStatus: ReservationStatus.CONFIRMED,
        propertyId: 'prop-uuid-1',
        inventoryUnitCode: 'DELUXE_KING',
        checkInDate: '2026-11-10',
        checkOutDate: '2026-11-12',
        unitsBooked: 1,
        guestName: 'Jane Doe',
      });

      expect(result).toBe(existingRecord);
      expect(mockInventoryService.bookInventoryUnits).not.toHaveBeenCalled();
      expect(prisma.reservation.update).not.toHaveBeenCalled();
    });
  });
});