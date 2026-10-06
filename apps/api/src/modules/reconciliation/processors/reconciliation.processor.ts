import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { SYNC_QUEUES } from '../../sync/sync.constants.js';
import { ReconciliationService } from '../reconciliation.service.js';
import { PartnerAdaptor } from '../../adaptors/partner-adaptor.interface.js';

@Processor(SYNC_QUEUES.RECONCILIATION, { concurrency: 1 })
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly reconciliationService: ReconciliationService,
    @Inject('ADAPTOR_REGISTRY')
    private readonly adaptors: Map<string, PartnerAdaptor>,
  ) {
    super();
  }

  async process(): Promise<void> {
    this.logger.log('Executing automated scheduled reconciliation cycle...');
    const capableAdaptors = Array.from(this.adaptors.values()).filter(
      (adaptor) => adaptor.capabilities?.polling,
    );

    for (const adaptor of capableAdaptors) {
      await this.reconciliationService.reconcilePartnerReservations(adaptor.partnerSlug);
    }
  }
}