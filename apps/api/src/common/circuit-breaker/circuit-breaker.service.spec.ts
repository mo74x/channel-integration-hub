import RedisMock from 'ioredis-mock';
import { CircuitBreakerService, CircuitState } from './circuit-breaker.service.js';

describe('CircuitBreakerService (with ioredis-mock)', () => {
  let service: CircuitBreakerService;
  let redis: any;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();

    process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD = '3';
    process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '1000';

    service = new CircuitBreakerService(redis);
  });

  afterEach(async () => {
    await redis.flushall();
    delete process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
  });

  describe('Full State Lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED', () => {
    it('progresses through all lifecycle states correctly', async () => {
      const partner = 'partner_a';

      // 1. Initial State: CLOSED
      expect(await service.canExecute(partner)).toBe(true);
      let status = await service.getStatus(partner);
      expect(status.state).toBe(CircuitState.CLOSED);
      expect(status.consecutiveFailures).toBe(0);

      // 2. Accumulate failures until threshold (3)
      await service.recordFailure(partner);
      await service.recordFailure(partner);
      expect(await service.canExecute(partner)).toBe(true); // Still closed before 3rd failure

      await service.recordFailure(partner); // 3rd failure trips the circuit
      status = await service.getStatus(partner);
      expect(status.state).toBe(CircuitState.OPEN);

      // 3. In OPEN: Outbound calls fail fast while cooldown has not elapsed
      expect(await service.canExecute(partner)).toBe(false);

      // 4. Simulate cooldown period elapsed (cooldown is 1000ms)
      const pastOpenedAt = (Date.now() - 2000).toString();
      await redis.set(`circuit:${partner}:opened_at`, pastOpenedAt);

      // 5. Next call acts as a trial probe and transitions to HALF_OPEN
      const probeAllowed = await service.canExecute(partner);
      expect(probeAllowed).toBe(true);
      status = await service.getStatus(partner);
      expect(status.state).toBe(CircuitState.HALF_OPEN);

      // 6. Successful probe response restores circuit to CLOSED
      await service.recordSuccess(partner);
      status = await service.getStatus(partner);
      expect(status.state).toBe(CircuitState.CLOSED);
      expect(status.consecutiveFailures).toBe(0);
      expect(await service.canExecute(partner)).toBe(true);
    });
  });

  describe('Single-probe behaviour & concurrency', () => {
    it('allows only a single probe through and rejects concurrent callers in HALF_OPEN', async () => {
      const partner = 'partner_b';

      // Trip to OPEN
      await service.recordFailure(partner);
      await service.recordFailure(partner);
      await service.recordFailure(partner);

      // Cooldown elapses
      const pastTime = (Date.now() - 2000).toString();
      await redis.set(`circuit:${partner}:opened_at`, pastTime);

      // Caller 1 acquires probe and transitions to HALF_OPEN
      const caller1 = await service.canExecute(partner);
      expect(caller1).toBe(true);

      // Caller 2 tries during HALF_OPEN while probe_lock is active
      const caller2 = await service.canExecute(partner);
      expect(caller2).toBe(false);
    });

    it('immediately re-opens circuit when trial probe fails in HALF_OPEN', async () => {
      const partner = 'partner_c';

      // Set directly to HALF_OPEN
      await redis.set(`circuit:${partner}:state`, CircuitState.HALF_OPEN);

      // Probe fails
      await service.recordFailure(partner);

      const status = await service.getStatus(partner);
      expect(status.state).toBe(CircuitState.OPEN);
      expect(await service.canExecute(partner)).toBe(false);
    });
  });

  describe('forceReset', () => {
    it('resets circuit from OPEN directly back to CLOSED', async () => {
      const partner = 'partner_d';

      await service.recordFailure(partner);
      await service.recordFailure(partner);
      await service.recordFailure(partner);

      expect((await service.getStatus(partner)).state).toBe(CircuitState.OPEN);

      await service.forceReset(partner);

      const status = await service.getStatus(partner);
      expect(status.state).toBe(CircuitState.CLOSED);
      expect(status.consecutiveFailures).toBe(0);
      expect(await service.canExecute(partner)).toBe(true);
    });
  });
});
