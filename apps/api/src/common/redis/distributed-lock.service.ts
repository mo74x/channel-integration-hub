import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from './redis.module.js';

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  // Atomic Lua unlock script: only deletes if the value matches the unique ownership token
  private readonly releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Attempts to acquire a distributed lock with automatic retries and jitter.
   *
   * @param key Resource key to lock
   * @param ttlMs Time-to-live in milliseconds
   * @param retries Maximum retry attempts
   * @param retryDelayMs Wait time between retries
   */
  async acquireLock(
    key: string,
    ttlMs = 5000,
    retries = 10,
    retryDelayMs = 150,
  ): Promise<{ token: string; key: string } | null> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') {
        return { token, key: lockKey };
      }

      if (attempt < retries) {
        const jitter = Math.floor(Math.random() * 50);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
      }
    }

    this.logger.warn(`Failed to acquire lock for key: ${lockKey} after ${retries} attempts`);
    return null;
  }

  /**
   * Releases an acquired lock using the atomic Lua script.
   */
  async releaseLock(lock: { token: string; key: string }): Promise<boolean> {
    try {
      const result = await this.redis.eval(this.releaseScript, 1, lock.key, lock.token);
      return result === 1;
    } catch (error) {
      this.logger.error(`Error releasing lock ${lock.key}:`, error);
      return false;
    }
  }

  /**
   * Wraps an asynchronous operation in an acquired lock, guaranteeing cleanup in a finally block.
   */
  async runWithLock<T>(
    key: string,
    operation: () => Promise<T>,
    ttlMs = 5000,
    retries = 10,
  ): Promise<T> {
    const lock = await this.acquireLock(key, ttlMs, retries);
    if (!lock) {
      throw new Error(`Resource is currently busy. Could not acquire lock for ${key}`);
    }

    try {
      return await operation();
    } finally {
      await this.releaseLock(lock);
    }
  }
}