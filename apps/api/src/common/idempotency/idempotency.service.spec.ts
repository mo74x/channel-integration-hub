import { ConflictException } from '@nestjs/common';
import { prisma } from '@cih/database';
import { IdempotencyService } from './idempotency.service.js';

jest.mock('@cih/database', () => ({
  prisma: {
    idempotencyRecord: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IdempotencyService();
  });

  describe('acquireOrReplay', () => {
    it('claims new lock when record does not exist', async () => {
      (prisma.idempotencyRecord.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (prisma.idempotencyRecord.upsert as jest.Mock).mockResolvedValueOnce({
        key: 'key-1',
        scope: 'WEBHOOK:PARTNER_A',
      });

      const result = await service.acquireOrReplay('key-1', 'WEBHOOK:PARTNER_A', 30);

      expect(result.isDuplicate).toBe(false);
      expect(result.cachedResponse).toBeUndefined();
      expect(prisma.idempotencyRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'key-1' },
          create: expect.objectContaining({ key: 'key-1', scope: 'WEBHOOK:PARTNER_A' }),
        }),
      );
    });

    it('returns cached response when request was completed earlier', async () => {
      const cached = { reservationId: 'res-101', status: 'CONFIRMED' };
      (prisma.idempotencyRecord.findUnique as jest.Mock).mockResolvedValueOnce({
        key: 'key-replay',
        responseStatus: 200,
        responseBody: cached,
        lockedUntil: null,
      });

      const result = await service.acquireOrReplay('key-replay', 'WEBHOOK:PARTNER_A');

      expect(result.isDuplicate).toBe(true);
      expect(result.cachedResponse).toEqual(cached);
      expect(prisma.idempotencyRecord.upsert).not.toHaveBeenCalled();
    });

    it('throws ConflictException when another worker currently holds the in-flight lock', async () => {
      const futureDate = new Date(Date.now() + 20000); // Locked for 20 more seconds
      (prisma.idempotencyRecord.findUnique as jest.Mock).mockResolvedValueOnce({
        key: 'key-inflight',
        responseStatus: null,
        responseBody: null,
        lockedUntil: futureDate,
      });

      await expect(service.acquireOrReplay('key-inflight', 'WEBHOOK:PARTNER_A')).rejects.toThrow(
        ConflictException,
      );
    });

    it('reclaims lock when previous lock has expired', async () => {
      const pastDate = new Date(Date.now() - 5000); // Lock expired 5s ago
      (prisma.idempotencyRecord.findUnique as jest.Mock).mockResolvedValueOnce({
        key: 'key-expired',
        responseStatus: null,
        responseBody: null,
        lockedUntil: pastDate,
      });
      (prisma.idempotencyRecord.upsert as jest.Mock).mockResolvedValueOnce({});

      const result = await service.acquireOrReplay('key-expired', 'WEBHOOK:PARTNER_A');

      expect(result.isDuplicate).toBe(false);
      expect(prisma.idempotencyRecord.upsert).toHaveBeenCalled();
    });
  });

  describe('commit', () => {
    it('persists response status, body and clears lock', async () => {
      const responseData = { acknowledged: true, bookingId: 'BK-1' };
      await service.commit('key-commit', 200, responseData);

      expect(prisma.idempotencyRecord.update).toHaveBeenCalledWith({
        where: { key: 'key-commit' },
        data: {
          responseStatus: 200,
          responseBody: responseData,
          lockedUntil: null,
        },
      });
    });
  });

  describe('rollback', () => {
    it('deletes idempotency record to allow retry', async () => {
      await service.rollback('key-err');

      expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledWith({
        where: { key: 'key-err' },
      });
    });
  });
});
