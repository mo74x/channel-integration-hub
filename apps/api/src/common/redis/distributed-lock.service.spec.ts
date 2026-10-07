import RedisMock from 'ioredis-mock';
import { DistributedLockService } from './distributed-lock.service.js';

describe('DistributedLockService', () => {
  let service: DistributedLockService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = new RedisMock();
    service = new DistributedLockService(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.flushall();
  });

  describe('acquireLock', () => {
    it('successfully acquires an unheld lock', async () => {
      const lock = await service.acquireLock('resource-1', 2000, 0);

      expect(lock).not.toBeNull();
      expect(lock?.key).toBe('lock:resource-1');
      expect(typeof lock?.token).toBe('string');

      // Verify value in redis matches token
      const val = await mockRedis.get('lock:resource-1');
      expect(val).toBe(lock?.token);
    });

    it('fails to acquire lock when already held and retries exhausted', async () => {
      // First caller acquires lock
      const lock1 = await service.acquireLock('busy-resource', 5000, 0);
      expect(lock1).not.toBeNull();

      // Second caller tries with 0 retries
      const lock2 = await service.acquireLock('busy-resource', 5000, 0, 10);
      expect(lock2).toBeNull();
    });
  });

  describe('releaseLock', () => {
    it('releases lock when token matches', async () => {
      const lock = await service.acquireLock('rel-resource', 5000, 0);
      expect(lock).not.toBeNull();

      // Mock redis.eval for Lua unlock script: deletes if match
      mockRedis.eval = jest.fn().mockImplementation(async (_script, _numKeys, key, token) => {
        const current = await mockRedis.get(key);
        if (current === token) {
          await mockRedis.del(key);
          return 1;
        }
        return 0;
      });

      const released = await service.releaseLock(lock!);
      expect(released).toBe(true);

      const remaining = await mockRedis.get(lock!.key);
      expect(remaining).toBeNull();
    });

    it('returns false if error occurs during release', async () => {
      mockRedis.eval = jest.fn().mockRejectedValue(new Error('Redis connection failed'));

      const released = await service.releaseLock({ key: 'lock:test', token: 'token-abc' });
      expect(released).toBe(false);
    });
  });

  describe('runWithLock', () => {
    it('executes operation under lock and releases lock on completion', async () => {
      mockRedis.eval = jest.fn().mockImplementation(async (_script, _numKeys, key, token) => {
        const current = await mockRedis.get(key);
        if (current === token) {
          await mockRedis.del(key);
          return 1;
        }
        return 0;
      });

      let executed = false;
      const result = await service.runWithLock(
        'wrapped-task',
        async () => {
          executed = true;
          return 'operation-result';
        },
        5000,
        1,
      );

      expect(executed).toBe(true);
      expect(result).toBe('operation-result');
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('releases lock even when operation throws an error', async () => {
      mockRedis.eval = jest.fn().mockImplementation(async (_script, _numKeys, key, _token) => {
        await mockRedis.del(key);
        return 1;
      });

      await expect(
        service.runWithLock(
          'failing-task',
          async () => {
            throw new Error('Task crashed');
          },
          5000,
          0,
        ),
      ).rejects.toThrow('Task crashed');

      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('throws error when lock cannot be acquired', async () => {
      // Hold lock
      await mockRedis.set('lock:locked-task', 'other-holder');

      await expect(
        service.runWithLock('locked-task', async () => 'not-run', 5000, 0),
      ).rejects.toThrow(/Resource is currently busy/);
    });
  });
});
