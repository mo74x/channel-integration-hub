import { OutboundSyncProcessor } from './outbound-sync.processor.js';
import { CircuitBreakerService } from '../../../common/circuit-breaker/circuit-breaker.service.js';
import { PartnerAdaptor } from '../../adaptors/partner-adaptor.interface.js';
import { prisma, SyncJobStatus } from '@cih/database';
import { Job, UnrecoverableError, DelayedError } from 'bullmq';
import { PartnerHttpError } from '../../../common/http/http-client.js';

jest.mock('@cih/database', () => ({
  prisma: {
    syncJob: {
      update: jest.fn(),
    },
  },
  SyncJobStatus: {
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    DEAD_LETTER: 'DEAD_LETTER',
  },
}));

describe('OutboundSyncProcessor', () => {
  let processor: OutboundSyncProcessor;
  let mockCircuitBreaker: jest.Mocked<CircuitBreakerService>;
  let mockAdaptor: jest.Mocked<PartnerAdaptor>;
  let adaptorsMap: Map<string, PartnerAdaptor>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCircuitBreaker = {
      canExecute: jest.fn().mockResolvedValue(true),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CircuitBreakerService>;

    mockAdaptor = {
      partnerSlug: 'partner_a',
      capabilities: { webhooks: true, polling: false, inventoryPush: true },
      pushInventory: jest.fn().mockResolvedValue({ success: true, partnerSyncId: 'ack-123' }),
    } as unknown as jest.Mocked<PartnerAdaptor>;

    adaptorsMap = new Map([['partner_a', mockAdaptor]]);
    processor = new OutboundSyncProcessor(adaptorsMap, mockCircuitBreaker);
  });

  const createMockJob = (overrides = {}) => {
    return {
      id: 'job-1',
      token: 'token-abc',
      attemptsMade: 0,
      opts: { attempts: 5 },
      data: {
        syncJobId: 'sync-123',
        partnerSlug: 'partner_a',
        update: {
          propertyId: 'prop-1',
          inventoryUnitCode: 'DELUXE',
          date: '2026-12-01',
          availableUnits: 5,
          priceInCents: 15000,
        },
      },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as Job<any>;
  };

  describe('Circuit-open delay', () => {
    it('delays job and throws DelayedError without burning a retry when circuit is OPEN', async () => {
      mockCircuitBreaker.canExecute.mockResolvedValue(false);
      const job = createMockJob();

      await expect(processor.process(job)).rejects.toThrow(DelayedError);

      expect(mockCircuitBreaker.canExecute).toHaveBeenCalledWith('partner_a');
      expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-abc');
      expect(prisma.syncJob.update).not.toHaveBeenCalled();
      expect(mockCircuitBreaker.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('Successful processing', () => {
    it('processes job successfully and records success on circuit breaker', async () => {
      const job = createMockJob();

      const result = await processor.process(job);

      expect(result).toEqual({ success: true, partnerSyncId: 'ack-123' });
      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalledWith('partner_a');
      expect(prisma.syncJob.update).toHaveBeenCalledWith({
        where: { id: 'sync-123' },
        data: { status: SyncJobStatus.PROCESSING, attempts: 1 },
      });
      expect(prisma.syncJob.update).toHaveBeenCalledWith({
        where: { id: 'sync-123' },
        data: { status: SyncJobStatus.COMPLETED, lastError: null },
      });
    });
  });

  describe('Retryable vs. unrecoverable errors', () => {
    it('throws UnrecoverableError and sends to DLQ without tripping circuit on 4xx responses', async () => {
      const error400 = new PartnerHttpError({
        message: 'Invalid room type code',
        status: 400,
        isRetryable: false,
      });
      mockAdaptor.pushInventory.mockRejectedValue(error400);

      const job = createMockJob();

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);

      // Circuit breaker must NOT record failure for 4xx errors
      expect(mockCircuitBreaker.recordFailure).not.toHaveBeenCalled();

      // Database record is moved directly to DEAD_LETTER (DLQ)
      expect(prisma.syncJob.update).toHaveBeenCalledWith({
        where: { id: 'sync-123' },
        data: {
          status: SyncJobStatus.DEAD_LETTER,
          lastError: expect.stringContaining('4xx'),
        },
      });
    });

    it('records failure and trips circuit breaker on 5xx retryable partner errors', async () => {
      const error500 = new PartnerHttpError({
        message: 'Partner service unavailable',
        status: 503,
        isRetryable: true,
      });
      mockAdaptor.pushInventory.mockRejectedValue(error500);

      const job = createMockJob();

      await expect(processor.process(job)).rejects.toThrow(error500);

      expect(mockCircuitBreaker.recordFailure).toHaveBeenCalledWith('partner_a');
      expect(prisma.syncJob.update).toHaveBeenCalledWith({
        where: { id: 'sync-123' },
        data: {
          status: SyncJobStatus.FAILED,
          lastError: expect.stringContaining('Partner service unavailable'),
        },
      });
    });

    it('throws error when adaptor is not found for partner slug', async () => {
      const job = createMockJob({
        data: {
          syncJobId: 'sync-999',
          partnerSlug: 'unknown_partner',
          update: {},
        },
      });

      await expect(processor.process(job)).rejects.toThrow(
        /Adaptor not found for partner slug: unknown_partner/,
      );
    });
  });

  describe('DLQ transitions (onJobFailed hook)', () => {
    it('moves job to DEAD_LETTER in onJobFailed hook when UnrecoverableError is thrown', async () => {
      const job = createMockJob();
      const error = new UnrecoverableError('Permanent validation rejection');

      await processor.onJobFailed(job, error);

      expect(prisma.syncJob.update).toHaveBeenCalledWith({
        where: { id: 'sync-123' },
        data: {
          status: SyncJobStatus.DEAD_LETTER,
          lastError: expect.stringContaining('Permanent validation rejection'),
        },
      });
    });

    it('moves job to DEAD_LETTER in onJobFailed hook when retry attempts are exhausted', async () => {
      const job = createMockJob({ attemptsMade: 5, opts: { attempts: 5 } });
      const error = new Error('503 Service Unavailable repeatedly');

      await processor.onJobFailed(job, error);

      expect(prisma.syncJob.update).toHaveBeenCalledWith({
        where: { id: 'sync-123' },
        data: {
          status: SyncJobStatus.DEAD_LETTER,
          lastError: expect.stringContaining(
            'Exhausted retries: 503 Service Unavailable repeatedly',
          ),
        },
      });
    });
  });
});
