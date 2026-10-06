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
  },
}));

describe('ReservationStateMachineService', () => {
  let service: ReservationStateMachineService;
  let mockInventoryService: Partial<InventoryService>;

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
    service = new ReservationStateMachineService(mockInventoryService as InventoryService);
  });

  it('should allow valid transition from PENDING to CONFIRMED and allocate units', async () => {
    (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.reservation.create as jest.Mock).mockResolvedValue({
      id: 'res-101',
      status: 'CONFIRMED',
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
  });

  it('should restore inventory capacity when transitioning from CONFIRMED to CANCELLED', async () => {
    (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
      id: 'res-101',
      status: 'CONFIRMED',
      inventoryUnitId: 'unit-uuid-1',
      checkInDate: new Date('2026-11-10'),
      checkOutDate: new Date('2026-11-12'),
      unitsBooked: 1,
      rawPayload: {},
    });

    (prisma.reservation.update as jest.Mock).mockResolvedValue({
      id: 'res-101',
      status: 'CANCELLED',
    });

    const result = await service.processTransition({
      partnerId: 'partner-uuid-1',
      externalBookingId: 'BOOK-99',
      targetStatus: ReservationStatus.CANCELLED,
      propertyId: 'prop-uuid-1',
      inventoryUnitCode: 'DELUXE_KING',
      checkInDate: '2026-11-10',
      checkOutDate: '2026-11-12',
      unitsBooked: 1,
      guestName: 'Jane Doe',
    });

    expect(mockInventoryService.restoreInventoryUnits).toHaveBeenCalled();
    expect(result.status).toBe('CANCELLED');
  });

  it('should REJECT out-of-order transition if a booking arrives as CONFIRMED after being CANCELLED', async () => {
    (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
      id: 'res-101',
      status: 'CANCELLED', // Terminal state
    });

    await expect(
      service.processTransition({
        partnerId: 'partner-uuid-1',
        externalBookingId: 'BOOK-99',
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

  it('should treat identical status transitions as idempotent no-ops', async () => {
    const existingRecord = {
      id: 'res-101',
      status: 'CONFIRMED',
    };
    (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(existingRecord);

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

    expect(result).toBe(existingRecord);
    expect(mockInventoryService.bookInventoryUnits).not.toHaveBeenCalled();
    expect(prisma.reservation.update).not.toHaveBeenCalled();
  });
});