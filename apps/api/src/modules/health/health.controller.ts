import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PostgresHealthIndicator } from './indicators/postgres.health.js';
import { RedisHealthIndicator } from './indicators/redis.health.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgresIndicator: PostgresHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness probe', description: 'Returns 200 if the API process is running. Does not check external dependencies.' })
  @ApiOkResponse({ description: 'Service is alive.' })
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe', description: 'Returns 200 only when both PostgreSQL and Redis are healthy and accepting connections.' })
  @ApiOkResponse({ description: 'All dependencies are healthy.' })
  @ApiServiceUnavailableResponse({ description: 'One or more dependencies are unhealthy.' })
  ready() {
    return this.health.check([
      () => this.postgresIndicator.isHealthy('postgres'),
      () => this.redisIndicator.isHealthy('redis'),
    ]);
  }
}

