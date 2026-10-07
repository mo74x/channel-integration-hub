import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service.js';
import { ReservationStateMachineService } from '../reservations/reservation-state-machine.service.js';
import { PartnerAdaptor } from '../adaptors/partner-adaptor.interface.js';
import { prisma, DriftResolution } from '@cih/database';
import { ReservationStatus } from '@cih/shared';

jest.mock('@cih/database', () => ({
  prisma: {
    reconciliationLog: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    reservation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    partner: {
      findUnique: jest.fn(),
    },
    propertyPartnerMapping: {
      findMany: jest.fn(),
    },
  },
  DriftResolution: {
    AUTO_CORRECTED: 'AUTO_CORRECTED',
    FLAGGED_FOR_REVIEW: 'FLAGGED_FOR_REVIEW',
    DISMISSED: 'DISMISSED',
  },
}));

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let mockStateMachine: jest.Mocked<Partial<ReservationStateMachineService>>;
  let mockAdaptor: jest.Mocked<PartnerAdaptor>;
  let mockAdaptors: Map<string, PartnerAdaptor>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStateMachine = {
      processTransition: jest.fn().mockResolvedValue({
        id: 'res-101',
        status: ReservationStatus.CANCELLED,
        version: 2,
      } as any),
    };

    mockAdaptor = {
      partnerSlug: 'partner_b',
      capabilities: { webhooks: false, polling: true, inventoryPush: false },
      pullReservations: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PartnerAdaptor>;

    mockAdaptors = new Map([['partner_b', mockAdaptor]]);
    service = new ReconciliationService(
      mockAdaptors,
      mockStateMachine as ReservationStateMachineService,
    );
  });

  describe('reconcilePartnerReservations (Drift Detection)', () => {
    it('returns 0 when partner adaptor is not registered', async () => {
      const result = await service.reconcilePartnerReservations('unknown_partner');
      expect(result).toBe(0);
    });

    it('returns 0 when partner is not found in database', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.reconcilePartnerReservations('partner_b');
      expect(result).toBe(0);
    });

    it('detects MISSING_IN_CANONICAL_DB drift when remote reservation is missing locally', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'part-b-id',
        name: 'Partner B',
        slug: 'partner_b',
      });

      (prisma.propertyPartnerMapping.findMany as jest.Mock).mockResolvedValue([
        { externalPropertyId: 'EXT-PROP-1' },
      ]);

      mockAdaptor.pullReservations.mockResolvedValueOnce([
        {
          externalBookingId: 'REMOTE-101',
          propertyId: 'prop-1',
          inventoryUnitCode: 'KING',
          checkInDate: '2026-11-01',
          checkOutDate: '2026-11-05',
          unitsBooked: 1,
          guestName: 'Drifter',
          totalPriceCents: 20000,
          currency: 'USD',
          status: ReservationStatus.CONFIRMED,
        },
      ]);

      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null); // Not found locally
      (prisma.reconciliationLog.create as jest.Mock).mockResolvedValue({ id: 'log-drift-1' });

      const driftCount = await service.reconcilePartnerReservations('partner_b');

      expect(driftCount).toBe(1);
      expect(prisma.reconciliationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            partnerId: 'part-b-id',
            entityType: 'RESERVATION',
            entityId: 'REMOTE-101',
            resolution: DriftResolution.FLAGGED_FOR_REVIEW,
          }),
        }),
      );
    });

    it('detects STATUS_MISMATCH drift when remote status differs from canonical', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'part-b-id',
        name: 'Partner B',
        slug: 'partner_b',
      });

      (prisma.propertyPartnerMapping.findMany as jest.Mock).mockResolvedValue([
        { externalPropertyId: 'EXT-PROP-1' },
      ]);

      mockAdaptor.pullReservations.mockResolvedValueOnce([
        {
          externalBookingId: 'DIFF-202',
          propertyId: 'prop-1',
          inventoryUnitCode: 'KING',
          checkInDate: '2026-11-01',
          checkOutDate: '2026-11-05',
          unitsBooked: 1,
          guestName: 'Jane',
          totalPriceCents: 20000,
          currency: 'USD',
          status: ReservationStatus.CANCELLED, // Remote cancelled
        },
      ]);

      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-diff',
        status: 'CONFIRMED', // Local still confirmed
        checkInDate: new Date('2026-11-01T00:00:00.000Z'),
        checkOutDate: new Date('2026-11-05T00:00:00.000Z'),
        unitsBooked: 1,
        guestName: 'Jane',
      });

      const driftCount = await service.reconcilePartnerReservations('partner_b');

      expect(driftCount).toBe(1);
      expect(prisma.reconciliationLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityId: 'res-diff',
            driftDetail: expect.objectContaining({
              issue: 'STATUS_MISMATCH',
              canonicalStatus: 'CONFIRMED',
              partnerStatus: 'CANCELLED',
            }),
          }),
        }),
      );
    });
  });

  describe('resolveDriftLog', () => {
    it('should throw BadRequestException if action is invalid', async () => {
      await expect(service.resolveDriftLog('log-1', 'INVALID_ACTION' as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if reconciliation log is not found', async () => {
      (prisma.reconciliationLog.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resolveDriftLog('unknown-log', 'DISMISS')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should update log as DISMISSED without calling state machine', async () => {
      (prisma.reconciliationLog.findUnique as jest.Mock).mockResolvedValue({
        id: 'log-1',
        driftDetail: { issue: 'STATUS_MISMATCH' },
      });
      (prisma.reconciliationLog.update as jest.Mock).mockResolvedValue({
        id: 'log-1',
        resolution: DriftResolution.DISMISSED,
      });

      const result = await service.resolveDriftLog('log-1', 'DISMISS');

      expect(result.success).toBe(true);
      expect(result.action).toBe('DISMISS');
      expect(prisma.reconciliationLog.update).toHaveBeenCalledWith({
        where: { id: 'log-1' },
        data: expect.objectContaining({
          resolution: DriftResolution.DISMISSED,
        }),
      });
      expect(mockStateMachine.processTransition).not.toHaveBeenCalled();
    });

    it('should update log as KEEP_CANONICAL without modifying reservation', async () => {
      (prisma.reconciliationLog.findUnique as jest.Mock).mockResolvedValue({
        id: 'log-2',
        driftDetail: { issue: 'STATUS_MISMATCH' },
      });
      (prisma.reconciliationLog.update as jest.Mock).mockResolvedValue({
        id: 'log-2',
        resolution: DriftResolution.AUTO_CORRECTED,
      });

      const result = await service.resolveDriftLog('log-2', 'KEEP_CANONICAL');

      expect(result.success).toBe(true);
      expect(result.action).toBe('KEEP_CANONICAL');
      expect(prisma.reconciliationLog.update).toHaveBeenCalledWith({
        where: { id: 'log-2' },
        data: expect.objectContaining({
          resolution: DriftResolution.AUTO_CORRECTED,
        }),
      });
      expect(mockStateMachine.processTransition).not.toHaveBeenCalled();
    });

    it('should apply partner status through state machine when action is ACCEPT_PARTNER on existing reservation', async () => {
      const existingLog = {
        id: 'log-3',
        partnerId: 'partner-uuid-a',
        entityId: 'res-uuid-1',
        partnerData: { status: 'CANCELLED' },
        driftDetail: { issue: 'STATUS_MISMATCH', partnerStatus: 'CANCELLED' },
      };
      (prisma.reconciliationLog.findUnique as jest.Mock).mockResolvedValue(existingLog);

      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue({
        id: 'res-uuid-1',
        partnerId: 'partner-uuid-a',
        externalBookingId: 'BOOK-101',
        status: 'CONFIRMED',
        propertyId: 'prop-1',
        checkInDate: new Date('2026-11-10T00:00:00.000Z'),
        checkOutDate: new Date('2026-11-12T00:00:00.000Z'),
        unitsBooked: 1,
        guestName: 'Jane Doe',
        totalPriceCents: 20000,
        currency: 'USD',
        inventoryUnit: { externalCode: 'DELUXE_KING' },
      });

      (prisma.reconciliationLog.update as jest.Mock).mockResolvedValue({
        id: 'log-3',
        resolution: DriftResolution.AUTO_CORRECTED,
      });

      const result = await service.resolveDriftLog('log-3', 'ACCEPT_PARTNER');

      expect(result.success).toBe(true);
      expect(result.action).toBe('ACCEPT_PARTNER');

      expect(mockStateMachine.processTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: 'partner-uuid-a',
          externalBookingId: 'BOOK-101',
          targetStatus: ReservationStatus.CANCELLED,
          propertyId: 'prop-1',
          inventoryUnitCode: 'DELUXE_KING',
        }),
      );

      expect(prisma.reconciliationLog.update).toHaveBeenCalledWith({
        where: { id: 'log-3' },
        data: expect.objectContaining({
          resolution: DriftResolution.AUTO_CORRECTED,
        }),
      });
    });

    it('should ingest missing reservation through state machine when ACCEPT_PARTNER on missing log', async () => {
      const missingLog = {
        id: 'log-4',
        partnerId: 'partner-uuid-b',
        entityId: 'BOOK-REMOTE-99',
        partnerData: {
          externalBookingId: 'BOOK-REMOTE-99',
          status: 'CONFIRMED',
          propertyId: 'prop-2',
          inventoryUnitCode: 'STANDARD_QUEEN',
          checkInDate: '2026-11-15',
          checkOutDate: '2026-11-17',
          unitsBooked: 1,
          guestName: 'John Smith',
          totalPriceCents: 15000,
          currency: 'USD',
        },
        driftDetail: { issue: 'MISSING_IN_CANONICAL_DB' },
      };

      (prisma.reconciliationLog.findUnique as jest.Mock).mockResolvedValue(missingLog);
      (prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null);

      (mockStateMachine.processTransition as jest.Mock).mockResolvedValue({
        id: 'res-new-99',
        status: ReservationStatus.CONFIRMED,
      });

      (prisma.reconciliationLog.update as jest.Mock).mockResolvedValue({
        id: 'log-4',
        resolution: DriftResolution.AUTO_CORRECTED,
      });

      const result = await service.resolveDriftLog('log-4', 'ACCEPT_PARTNER');

      expect(result.success).toBe(true);
      expect(mockStateMachine.processTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: 'partner-uuid-b',
          externalBookingId: 'BOOK-REMOTE-99',
          targetStatus: ReservationStatus.CONFIRMED,
          propertyId: 'prop-2',
          inventoryUnitCode: 'STANDARD_QUEEN',
        }),
      );
    });
  });
});
