import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SYNC_QUEUES, SYNC_JOBS } from './sync.constants.js';
import { AdaptorsModule } from '../adaptors/adaptors.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SyncService } from './sync.service.js';
import { OutboundSyncProcessor } from './processors/outbound-sync.processor.js';
import { PollingProcessor } from './processors/polling.processor.js';
import { AvailabilityFanoutListener } from './availability-fanout.listener.js';

@Module({
  imports: [
    AdaptorsModule,
    forwardRef(() => ReservationsModule),
    BullModule.registerQueue(
      { name: SYNC_QUEUES.OUTBOUND_INVENTORY },
      { name: SYNC_QUEUES.POLLING_RESERVATIONS },
      { name: SYNC_QUEUES.RECONCILIATION },
    ),
  ],
  providers: [SyncService, OutboundSyncProcessor, PollingProcessor, AvailabilityFanoutListener],
  exports: [SyncService, AvailabilityFanoutListener],
})
export class SyncModule implements OnModuleInit {
  constructor(
    @InjectQueue(SYNC_QUEUES.POLLING_RESERVATIONS)
    private readonly pollingQueue: Queue,
    @InjectQueue(SYNC_QUEUES.RECONCILIATION)
    private readonly reconciliationQueue: Queue,
  ) {}

  async onModuleInit() {
    // Schedule repeatable polling every 60 seconds for Partner B[cite: 1]
    await this.pollingQueue.add(
      SYNC_JOBS.POLL_PARTNER_RESERVATIONS,
      {},
      {
        repeat: { every: 60000 },
        removeOnComplete: true,
      },
    );

    // Schedule automated drift reconciliation every 15 minutes[cite: 1]
    await this.reconciliationQueue.add(
      SYNC_JOBS.RUN_RECONCILIATION,
      {},
      {
        repeat: { every: 900000 },
        removeOnComplete: true,
      },
    );
  }
}
