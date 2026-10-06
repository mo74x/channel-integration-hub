import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { prisma } from '@cih/database';

@Injectable()
export class PostgresHealthIndicator extends HealthIndicator {
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return this.getStatus(key, true);
    } catch (error: any) {
      throw new HealthCheckError(
        'Postgres health check failed',
        this.getStatus(key, false, { message: error.message }),
      );
    }
  }
}
