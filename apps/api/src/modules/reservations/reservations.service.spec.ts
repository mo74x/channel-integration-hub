import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReservationsService } from './reservations.service.js';
import { prisma } from '@cih/database';
import { ReservationStatus } from '@cih/shared';

jest.mock('@cih/database', () => ({
  prisma: {
    reservation: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

describe('ReservationsService', () => {
  let service: ReservationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReservationsService();
  });

  describe('findReservations', () => {
    it('should query reservations with default pagination when no filters are provided', async () => {
      (prisma.reservation.count as jest.Mock).mockResolvedValue(1);
      (prisma.reservation.findMany as jest.Mock).mockResolvedValue([
        { id: 'res-1', status: 'CONFIRMED' },
      ]);

      const result = await service.findReservations({});

      expect(prisma.reservation.count).toHaveBeenCalledWith({ where: {} });
      expect(prisma.reservation.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(20);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPrevPage).toBe(false);
    });

    it('should filter by partner ID or slug', async () => {
      (prisma.reservation.count as jest.Mock).mockResolvedValue(1);
      (prisma.reservation.findMany as jest.Mock).mockResolvedValue([
        { id: 'res-1', partnerId: 'partner-1' },
      ]);

      await service.findReservations({ partner: 'partner_a' });

      expect(prisma.reservation.count).toHaveBeenCalledWith({
        where: {
          OR: [{ partnerId: 'partner_a' }, { partner: { slug: 'partner_a' } }],
        },
      });
    });

    it('should filter by reservation status', async () => {
      (prisma.reservation.count as jest.Mock).mockResolvedValue(1);
      (prisma.reservation.findMany as jest.Mock).mockResolvedValue([
        { id: 'res-1', status: ReservationStatus.CONFIRMED },
      ]);

      await service.findReservations({ status: ReservationStatus.CONFIRMED });

      expect(prisma.reservation.count).toHaveBeenCalledWith({
        where: { status: ReservationStatus.CONFIRMED },
      });
    });

    it('should throw BadRequestException on invalid status', async () => {
      await expect(service.findReservations({ status: 'INVALID_STATUS' as any })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should filter by stay check-in date range', async () => {
      (prisma.reservation.count as jest.Mock).mockResolvedValue(1);
      (prisma.reservation.findMany as jest.Mock).mockResolvedValue([{ id: 'res-1' }]);

      await service.findReservations({ from: '2026-11-10', to: '2026-11-20' });

      expect(prisma.reservation.count).toHaveBeenCalledWith({
        where: {
          checkInDate: {
            gte: new Date('2026-11-10T00:00:00.000Z'),
            lte: new Date('2026-11-20T00:00:00.000Z'),
          },
        },
      });
    });

    it('should throw BadRequestException if date format is invalid or from > to', async () => {
      await expect(service.findReservations({ from: 'invalid-date' })).rejects.toThrow(
        BadRequestException,
      );

      await expect(
        service.findReservations({ from: '2026-11-20', to: '2026-11-10' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should calculate pagination correctly across multiple pages', async () => {
      (prisma.reservation.count as jest.Mock).mockResolvedValue(55);
      (prisma.reservation.findMany as jest.Mock).mockResolvedValue(
        new Array(10).fill({ id: 'res' }),
      );

      const result = await service.findReservations({ page: 2, limit: 10 });

      expect(prisma.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );

      expect(result.pagination.total).toBe(55);
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.totalPages).toBe(6);
      expect(result.pagination.hasNextPage).toBe(true);
      expect(result.pagination.hasPrevPage).toBe(true);
    });
  });

  describe('getReservationById', () => {
    it('should return reservation by ID when found', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-uuid-1',
        guestName: 'Jane Doe',
      });

      const res = await service.getReservationById('res-uuid-1');

      expect(prisma.reservation.findUnique).toHaveBeenCalledWith({
        where: { id: 'res-uuid-1' },
        include: expect.any(Object),
      });
      expect(res.guestName).toBe('Jane Doe');
    });

    it('should fallback to external booking ID when primary ID is not found', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.reservation.findFirst as jest.Mock).mockResolvedValue({
        id: 'res-uuid-1',
        externalBookingId: 'BOOK-EXT-99',
        guestName: 'Jane Doe',
      });

      const res = await service.getReservationById('BOOK-EXT-99');

      expect(prisma.reservation.findFirst).toHaveBeenCalledWith({
        where: { externalBookingId: 'BOOK-EXT-99' },
        include: expect.any(Object),
      });
      expect(res.externalBookingId).toBe('BOOK-EXT-99');
    });

    it('should throw NotFoundException if neither ID nor external ID matches', async () => {
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.reservation.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.getReservationById('unknown-id')).rejects.toThrow(NotFoundException);
    });
  });
});
