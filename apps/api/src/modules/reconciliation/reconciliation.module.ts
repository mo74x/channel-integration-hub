import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SYNC_QUEUES } from '../sync/sync.constants.js';
import { AdaptorsModule } from '../adaptors/adaptors.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationProcessor } from './processors/reconciliation.processor.js';

@Module({
  imports: [
    AdaptorsModule,
    ReservationsModule,
    BullModule.registerQueue({
      name: SYNC_QUEUES.RECONCILIATION,
    }),
  ],
  providers: [ReconciliationService, ReconciliationProcessor],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
