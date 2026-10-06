import { HealthController } from './health.controller.js';
import { HealthCheckService } from '@nestjs/terminus';
import { PostgresHealthIndicator } from './indicators/postgres.health.js';
import { RedisHealthIndicator } from './indicators/redis.health.js';

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: jest.Mocked<HealthCheckService>;
  let postgresIndicator: jest.Mocked<PostgresHealthIndicator>;
  let redisIndicator: jest.Mocked<RedisHealthIndicator>;

  beforeEach(() => {
    healthService = {
      check: jest.fn().mockImplementation(async (indicators: any[]) => {
        const results: Record<string, any> = {};
        for (const indicator of indicators) {
          const res = await indicator();
          Object.assign(results, res);
        }
        return {
          status: 'ok',
          info: results,
          error: {},
          details: results,
        };
      }),
    } as unknown as jest.Mocked<HealthCheckService>;

    postgresIndicator = {
      isHealthy: jest.fn().mockResolvedValue({ postgres: { status: 'up' } }),
    } as unknown as jest.Mocked<PostgresHealthIndicator>;

    redisIndicator = {
      isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up' } }),
    } as unknown as jest.Mocked<RedisHealthIndicator>;

    controller = new HealthController(healthService, postgresIndicator, redisIndicator);
  });

  it('live returns successful health check', async () => {
    const res = await controller.live();
    expect(res.status).toBe('ok');
    expect(healthService.check).toHaveBeenCalledWith([]);
  });

  it('ready checks both postgres and redis indicators', async () => {
    const res = await controller.ready();
    expect(res.status).toBe('ok');
    expect(postgresIndicator.isHealthy).toHaveBeenCalledWith('postgres');
    expect(redisIndicator.isHealthy).toHaveBeenCalledWith('redis');
  });
});
