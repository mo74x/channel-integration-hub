import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';

export enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Partner down; fail fast
  HALF_OPEN = 'HALF_OPEN', // Trial probe request
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private get failureThreshold(): number {
    const val = parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5', 10);
    return isNaN(val) || val <= 0 ? 5 : val;
  }

  private get cooldownPeriodMs(): number {
    const val = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || '30000', 10);
    return isNaN(val) || val <= 0 ? 30000 : val;
  }

  private getStateKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:state`;
  }

  private getFailuresKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:failures`;
  }

  private getOpenedAtKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:opened_at`;
  }

  private getProbeKey(partnerSlug: string): string {
    return `circuit:${partnerSlug}:probe_lock`;
  }

  /**
   * Checks if an outbound call is allowed for the target partner.
   * In OPEN state, allows only a single probe through using atomic Redis SET NX.
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
        // Attempt single-probe acquisition using atomic SET NX
        const probeAcquired = await this.redis.set(
          this.getProbeKey(partnerSlug),
          '1',
          'PX',
          this.cooldownPeriodMs,
          'NX',
        );

        if (probeAcquired === 'OK') {
          await this.redis.set(this.getStateKey(partnerSlug), CircuitState.HALF_OPEN);
          this.logger.warn(`Circuit for ${partnerSlug} transitioned to HALF_OPEN (probing...)`);
          return true;
        }
      }

      return false; // Circuit still open or another worker acquired probe
    }

    if (state === CircuitState.HALF_OPEN) {
      // In HALF_OPEN, enforce single probe; only caller holding the probe key proceeds
      const probeAcquired = await this.redis.set(
        this.getProbeKey(partnerSlug),
        '1',
        'PX',
        this.cooldownPeriodMs,
        'NX',
      );
      return probeAcquired === 'OK';
    }

    return false;
  }

  /**
   * Records a successful partner API response and resets failure counters and circuit state.
   */
  async recordSuccess(partnerSlug: string): Promise<void> {
    await this.redis
      .pipeline()
      .set(this.getStateKey(partnerSlug), CircuitState.CLOSED)
      .del(this.getFailuresKey(partnerSlug))
      .del(this.getOpenedAtKey(partnerSlug))
      .del(this.getProbeKey(partnerSlug))
      .exec();

    this.logger.log(`Circuit for partner '${partnerSlug}' reset to CLOSED.`);
  }

  /**
   * Records a partner network or 5xx error.
   * If in HALF_OPEN, a failed probe immediately re-opens the circuit without waiting for threshold.
   * If in CLOSED, trips the circuit to OPEN once the failure threshold is reached.
   */
  async recordFailure(partnerSlug: string): Promise<void> {
    const state = (await this.redis.get(this.getStateKey(partnerSlug))) || CircuitState.CLOSED;

    // A failed probe in HALF_OPEN immediately re-opens the circuit
    if (state === CircuitState.HALF_OPEN) {
      await this.redis
        .pipeline()
        .set(this.getStateKey(partnerSlug), CircuitState.OPEN)
        .set(this.getOpenedAtKey(partnerSlug), Date.now().toString())
        .del(this.getProbeKey(partnerSlug))
        .exec();

      this.logger.error(
        `Trial probe failed for partner '${partnerSlug}' in HALF_OPEN. Circuit re-opened immediately to OPEN.`,
      );
      return;
    }

    const failuresKey = this.getFailuresKey(partnerSlug);
    const failures = await this.redis.incr(failuresKey);

    if (failures >= this.failureThreshold) {
      await this.redis
        .pipeline()
        .set(this.getStateKey(partnerSlug), CircuitState.OPEN)
        .set(this.getOpenedAtKey(partnerSlug), Date.now().toString())
        .del(this.getProbeKey(partnerSlug))
        .exec();

      this.logger.error(
        `Circuit for partner '${partnerSlug}' tripped to OPEN after ${failures} consecutive failures. Fast-failing outbound sync.`,
      );
    }
  }

  /**
   * Manually resets the circuit breaker to CLOSED, clearing all failure counters and locks for operators.
   */
  async forceReset(partnerSlug: string): Promise<void> {
    await this.recordSuccess(partnerSlug);
    this.logger.warn(`Circuit for partner '${partnerSlug}' force-reset to CLOSED by operator.`);
  }

  /**
   * Fetches current circuit status for operational monitoring.
   */
  async getStatus(
    partnerSlug: string,
  ): Promise<{ state: CircuitState; consecutiveFailures: number }> {
    const state =
      ((await this.redis.get(this.getStateKey(partnerSlug))) as CircuitState) ||
      CircuitState.CLOSED;
    const failures = parseInt((await this.redis.get(this.getFailuresKey(partnerSlug))) || '0', 10);
    return { state, consecutiveFailures: failures };
  }
}
