import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';

export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',           // Partner down; fail fast
  HALF_OPEN = 'HALF_OPEN', // Trial probe request
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  private readonly failureThreshold = 5;      // Consecutive failures to open circuit
  private readonly cooldownPeriodMs = 30000;  // 30 seconds cooldown before half-open probe

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private getStateKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:state`;
  }

  private getFailuresKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:failures`;
  }

  private getOpenedAtKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:opened_at`;
  }

  /**
   * Checks if an outbound call is allowed for the target partner.
   */
  async canExecute(partnerSlug: string): Promise<boolean> {
    const state = (await this.redis.get(this.getStateKey(partnerSlug))) || CircuitState.CLOSED;

    if (state === CircuitState.CLOSED) {
      return true;
    }

    if (state === CircuitState.OPEN) {
      const openedAtStr = await this.redis.get(this.getOpenedAtKey(partnerSlug));
      const openedAt = openedAtStr ? parseInt(openedAtStr, 10) : 0;
      const elapsed = Date.now() - openedAt;

      if (elapsed > this.cooldownPeriodMs) {
        // Transition to HALF_OPEN to allow a single trial probe
        await this.redis.set(this.getStateKey(partnerSlug), CircuitState.HALF_OPEN);
        this.logger.warn(`Circuit for ${partnerSlug} transitioned to HALF_OPEN (probing...)`);
        return true;
      }

      return false; // Circuit still open; fast fail
    }

    // When HALF_OPEN, allow probe
    return true;
  }

  /**
   * Records a successful partner API response and resets failure counters.
   */
  async recordSuccess(partnerSlug: string): Promise<void> {
    await this.redis.pipeline()
      .set(this.getStateKey(partnerSlug), CircuitState.CLOSED)
      .del(this.getFailuresKey(partnerSlug))
      .del(this.getOpenedAtKey(partnerSlug))
      .exec();
  }

  /**
   * Records a partner network or 5xx error, tripping the circuit if threshold is reached.
   */
  async recordFailure(partnerSlug: string): Promise<void> {
    const failuresKey = this.getFailuresKey(partnerSlug);
    const failures = await this.redis.incr(failuresKey);

    if (failures >= this.failureThreshold) {
      await this.redis.pipeline()
        .set(this.getStateKey(partnerSlug), CircuitState.OPEN)
        .set(this.getOpenedAtKey(partnerSlug), Date.now().toString())
        .exec();

      this.logger.error(
        `Circuit for partner '${partnerSlug}' is now OPEN after ${failures} consecutive failures. Fast-failing outbound sync.`,
      );
    }
  }

  /**
   * Fetches current circuit status for operational monitoring.
   */
  async getStatus(partnerSlug: string): Promise<{ state: CircuitState; consecutiveFailures: number }> {
    const state = ((await this.redis.get(this.getStateKey(partnerSlug))) as CircuitState) || CircuitState.CLOSED;
    const failures = parseInt((await this.redis.get(this.getFailuresKey(partnerSlug))) || '0', 10);
    return { state, consecutiveFailures: failures };
  }
}