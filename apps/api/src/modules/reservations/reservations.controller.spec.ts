import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationStatus } from '@cih/shared';

describe('ReservationsController', () => {
  let controller: ReservationsController;
  let mockReservationsService: jest.Mocked<Partial<ReservationsService>>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockReservationsService = {
      findReservations: jest.fn().mockResolvedValue({
        data: [{ id: 'res-1', status: 'CONFIRMED' }],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      } as any),
      getReservationById: jest.fn().mockResolvedValue({
        id: 'res-1',
        status: 'CONFIRMED',
        guestName: 'John Doe',
      } as any),
    };

    controller = new ReservationsController(mockReservationsService as ReservationsService);
  });

  describe('GET /reservations', () => {
    it('should delegate query parameters to reservationsService.findReservations', async () => {
      const query = {
        partner: 'partner_a',
        status: ReservationStatus.CONFIRMED,
        from: '2026-11-10',
        to: '2026-11-20',
        page: 1,
        limit: 10,
      };

      const result = await controller.getReservations(query);

      expect(mockReservationsService.findReservations).toHaveBeenCalledWith(query);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('GET /reservations/:id', () => {
    it('should delegate reservation ID to reservationsService.getReservationById', async () => {
      const result = await controller.getReservationById('res-1');

      expect(mockReservationsService.getReservationById).toHaveBeenCalledWith('res-1');
      expect(result.id).toBe('res-1');
      expect(result.guestName).toBe('John Doe');
    });
  });
});
