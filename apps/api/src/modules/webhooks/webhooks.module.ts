import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { AdaptorsModule } from '../adaptors/adaptors.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';

@Module({
  imports: [AdaptorsModule, ReservationsModule],
  controllers: [WebhooksController],
  providers: [IdempotencyService],
})
export class WebhooksModule {}