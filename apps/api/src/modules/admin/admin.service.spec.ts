import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { CircuitBreakerService, CircuitState } from '../../common/circuit-breaker/circuit-breaker.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { prisma, PartnerStatus } from '@cih/database';
import { Queue } from 'bullmq';

jest.mock('@cih/database', () => ({
  prisma: {
    partner: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    syncJob: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    reconciliationLog: {
      findMany: jest.fn(),
    },
  },
  PartnerStatus: {
    ACTIVE: 'ACTIVE',
    DEGRADED: 'DEGRADED',
    CIRCUIT_OPEN: 'CIRCUIT_OPEN',
    DISABLED: 'DISABLED',
  },
  SyncJobStatus: {
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    DEAD_LETTER: 'DEAD_LETTER',
  },
  SyncJobType: {
    OUTBOUND_PUSH: 'OUTBOUND_PUSH',
  },
}));

describe('AdminService - Circuit and Partner Management', () => {
  let service: AdminService;
  let mockCircuitBreaker: jest.Mocked<CircuitBreakerService>;
  let mockReconciliationService: jest.Mocked<ReconciliationService>;
  let mockInventoryQueue: jest.Mocked<Partial<Queue>>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCircuitBreaker = {
      forceReset: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockResolvedValue({
        state: CircuitState.CLOSED,
        consecutiveFailures: 0,
      }),
      canExecute: jest.fn().mockResolvedValue(true),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CircuitBreakerService>;

    mockReconciliationService = {
      reconcilePartnerReservations: jest.fn().mockResolvedValue(0),
      resolveDriftLog: jest.fn().mockResolvedValue({ success: true } as any),
    } as unknown as jest.Mocked<ReconciliationService>;

    mockInventoryQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' } as any),
    };

    service = new AdminService(
      mockCircuitBreaker,
      mockReconciliationService,
      mockInventoryQueue as Queue,
    );
  });

  describe('resetPartnerCircuit', () => {
    it('should throw NotFoundException if partner does not exist', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resetPartnerCircuit('unknown_partner'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should force reset circuit breaker and update status if partner was CIRCUIT_OPEN', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        status: PartnerStatus.CIRCUIT_OPEN,
      });

      (prisma.partner.update as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        status: PartnerStatus.ACTIVE,
      });

      const result = await service.resetPartnerCircuit('partner_a');

      expect(mockCircuitBreaker.forceReset).toHaveBeenCalledWith('partner_a');
      expect(prisma.partner.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: { status: PartnerStatus.ACTIVE },
      });
      expect(result.success).toBe(true);
      expect(result.circuitState).toBe(CircuitState.CLOSED);
      expect(result.consecutiveFailures).toBe(0);
    });

    it('should reset circuit breaker without changing status if partner is already ACTIVE', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        status: PartnerStatus.ACTIVE,
      });

      const result = await service.resetPartnerCircuit('partner_a');

      expect(mockCircuitBreaker.forceReset).toHaveBeenCalledWith('partner_a');
      expect(prisma.partner.update).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('updatePartnerStatus', () => {
    it('should throw BadRequestException if neither enabled nor status is provided', async () => {
      await expect(
        service.updatePartnerStatus('partner_a', {} as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if status is invalid', async () => {
      await expect(
        service.updatePartnerStatus('partner_a', { status: 'INVALID' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if partner does not exist', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updatePartnerStatus('unknown_partner', { enabled: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should disable a partner when enabled: false is sent', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        name: 'Partner A',
        status: PartnerStatus.ACTIVE,
      });

      (prisma.partner.update as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        name: 'Partner A',
        status: PartnerStatus.DISABLED,
      });

      const result = await service.updatePartnerStatus('partner_a', { enabled: false });

      expect(prisma.partner.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: { status: PartnerStatus.DISABLED },
      });
      expect(result.partner.status).toBe(PartnerStatus.DISABLED);
    });

    it('should enable a partner when enabled: true is sent and reset its circuit breaker', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        name: 'Partner A',
        status: PartnerStatus.DISABLED,
      });

      (prisma.partner.update as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_a',
        name: 'Partner A',
        status: PartnerStatus.ACTIVE,
      });

      const result = await service.updatePartnerStatus('partner_a', { enabled: true });

      expect(prisma.partner.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: { status: PartnerStatus.ACTIVE },
      });
      expect(mockCircuitBreaker.forceReset).toHaveBeenCalledWith('partner_a');
      expect(result.partner.status).toBe(PartnerStatus.ACTIVE);
    });

    it('should support explicit status parameter', async () => {
      (prisma.partner.findUnique as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_b',
        name: 'Partner B',
        status: PartnerStatus.ACTIVE,
      });

      (prisma.partner.update as jest.Mock).mockResolvedValue({
        id: 'p-1',
        slug: 'partner_b',
        name: 'Partner B',
        status: PartnerStatus.DISABLED,
      });

      const result = await service.updatePartnerStatus('partner_b', {
        status: PartnerStatus.DISABLED,
      });

      expect(result.partner.status).toBe(PartnerStatus.DISABLED);
    });
  });
});
