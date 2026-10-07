import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { RedisModule } from './common/redis/redis.module.js';
import { IdempotencyService } from './common/idempotency/idempotency.service.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { AdaptorsModule } from './modules/adaptors/adaptors.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { SchemaMapperModule } from './modules/schema-mapper/schema-mapper.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { validateEnv } from './config/env.validation.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
      validate: validateEnv,
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || 'redis_secure_password',
      },
    }),
    RedisModule,
    InventoryModule,
    AdaptorsModule,
    WebhooksModule,
    ReservationsModule,
    SyncModule,
    ReconciliationModule,
    AdminModule,
    SchemaMapperModule,
    HealthModule,
  ],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
