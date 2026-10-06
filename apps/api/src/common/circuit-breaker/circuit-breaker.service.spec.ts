import { CircuitBreakerService, CircuitState } from './circuit-breaker.service.js';
import Redis from 'ioredis';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;
  let mockRedis: jest.Mocked<Redis>;
  let mockPipeline: any;

  beforeEach(() => {
    mockPipeline = {
      set: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };

    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      incr: jest.fn(),
      pipeline: jest.fn().mockReturnValue(mockPipeline),
    } as unknown as jest.Mocked<Redis>;

    delete process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;

    service = new CircuitBreakerService(mockRedis);
  });

  describe('canExecute', () => {
    it('returns true when circuit is CLOSED', async () => {
      mockRedis.get.mockResolvedValueOnce(CircuitState.CLOSED);
      const allowed = await service.canExecute('partner_a');
      expect(allowed).toBe(true);
    });

    it('returns false when circuit is OPEN and cooldown has not elapsed', async () => {
      mockRedis.get
        .mockResolvedValueOnce(CircuitState.OPEN)
        .mockResolvedValueOnce(Date.now().toString()); // opened just now

      const allowed = await service.canExecute('partner_a');
      expect(allowed).toBe(false);
    });

    it('allows a single probe via SET NX when cooldown has elapsed, transitioning to HALF_OPEN', async () => {
      const pastTime = (Date.now() - 35000).toString(); // 35s ago (cooldown is 30s)
      mockRedis.get
        .mockResolvedValueOnce(CircuitState.OPEN)
        .mockResolvedValueOnce(pastTime);

      mockRedis.set.mockResolvedValueOnce('OK'); // SET NX succeeds for probe

      const allowed = await service.canExecute('partner_a');
      expect(allowed).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'circuit:partner_a:probe_lock',
        '1',
        'PX',
        30000,
        'NX',
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        'circuit:partner_a:state',
        CircuitState.HALF_OPEN,
      );
    });

    it('rejects concurrent probe callers when SET NX returns null', async () => {
      const pastTime = (Date.now() - 35000).toString();
      mockRedis.get
        .mockResolvedValueOnce(CircuitState.OPEN)
        .mockResolvedValueOnce(pastTime);

      mockRedis.set.mockResolvedValueOnce(null as any); // Another worker holds the probe lock

      const allowed = await service.canExecute('partner_a');
      expect(allowed).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('immediately re-opens circuit when in HALF_OPEN without waiting for threshold', async () => {
      mockRedis.get.mockResolvedValueOnce(CircuitState.HALF_OPEN);

      await service.recordFailure('partner_a');

      expect(mockPipeline.set).toHaveBeenCalledWith('circuit:partner_a:state', CircuitState.OPEN);
      expect(mockPipeline.del).toHaveBeenCalledWith('circuit:partner_a:probe_lock');
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('trips circuit to OPEN when failure count reaches threshold in CLOSED state', async () => {
      mockRedis.get.mockResolvedValueOnce(CircuitState.CLOSED);
      mockRedis.incr.mockResolvedValueOnce(5); // threshold is 5

      await service.recordFailure('partner_a');

      expect(mockPipeline.set).toHaveBeenCalledWith('circuit:partner_a:state', CircuitState.OPEN);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });

  describe('forceReset and recordSuccess', () => {
    it('forceReset resets circuit to CLOSED and deletes all failure and probe keys', async () => {
      await service.forceReset('partner_a');

      expect(mockPipeline.set).toHaveBeenCalledWith('circuit:partner_a:state', CircuitState.CLOSED);
      expect(mockPipeline.del).toHaveBeenCalledWith('circuit:partner_a:failures');
      expect(mockPipeline.del).toHaveBeenCalledWith('circuit:partner_a:opened_at');
      expect(mockPipeline.del).toHaveBeenCalledWith('circuit:partner_a:probe_lock');
      expect(mockPipeline.exec).toHaveBeenCalled();
    });
  });
});
