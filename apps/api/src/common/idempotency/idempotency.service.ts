import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { prisma } from '@cih/database';

export interface IdempotencyResult<T> {
  isDuplicate: boolean;
  cachedResponse?: T;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /**
   * Claims an idempotency key.
   * If the key completed earlier, returns the cached result.
   * If currently in flight, raises a 409 Conflict.
   */
  async acquireOrReplay<T>(
    key: string,
    scope: string,
    lockTtlSeconds = 30,
  ): Promise<IdempotencyResult<T>> {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() + lockTtlSeconds * 1000);

    const existing = await prisma.idempotencyRecord.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.responseStatus !== null && existing.responseBody !== null) {
        this.logger.log(`Idempotent replay triggered for key: ${key}`);
        return {
          isDuplicate: true,
          cachedResponse: existing.responseBody as T,
        };
      }

      if (existing.lockedUntil && existing.lockedUntil > now) {
        throw new ConflictException(
          `Request with key '${key}' is currently being processed by another worker.`,
        );
      }
    }

    await prisma.idempotencyRecord.upsert({
      where: { key },
      create: {
        key,
        scope,
        lockedUntil: lockExpiry,
      },
      update: {
        lockedUntil: lockExpiry,
      },
    });

    return { isDuplicate: false };
  }

  /**
   * Persists the response and releases the in-flight lock.
   */
  async commit<T>(key: string, status: number, responseBody: T): Promise<void> {
    await prisma.idempotencyRecord.update({
      where: { key },
      data: {
        responseStatus: status,
        responseBody: responseBody as object,
        lockedUntil: null,
      },
    });
  }

  /**
   * Removes an idempotency record if an unrecoverable failure requires retry.
   */
  async rollback(key: string): Promise<void> {
    await prisma.idempotencyRecord.deleteMany({
      where: { key },
    });
  }
}