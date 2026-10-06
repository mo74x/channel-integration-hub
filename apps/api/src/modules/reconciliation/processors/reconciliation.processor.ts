import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { SYNC_QUEUES } from '../../sync/sync.constants.js';
import { ReconciliationService } from '../reconciliation.service.js';

@Processor(SYNC_QUEUES.RECONCILIATION, { concurrency: 1 })
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(private readonly reconciliationService: ReconciliationService) {
    super();
  }

  async process(): Promise<void> {
    this.logger.log('Executing automated scheduled reconciliation cycle...');
    await this.reconciliationService.reconcilePartnerReservations('partner_b');
  }
}