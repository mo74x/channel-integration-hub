import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SYNC_QUEUES } from '../sync/sync.constants.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';

@Module({
  imports: [
    ReconciliationModule,
    BullModule.registerQueue({
      name: SYNC_QUEUES.OUTBOUND_INVENTORY,
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}