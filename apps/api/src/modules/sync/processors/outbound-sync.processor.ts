import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { prisma, SyncJobStatus } from '@cih/database';
import { CanonicalInventoryPushPayload } from '@cih/shared';
import { SYNC_QUEUES } from '../sync.constants.js';
import { PartnerAdaptor } from '../../adaptors/partner-adaptor.interface.js';
import { CircuitBreakerService } from '../../../common/circuit-breaker/circuit-breaker.service.js';

interface OutboundInventoryJobData {
  syncJobId: string;
  partnerSlug: string;
  update: CanonicalInventoryPushPayload;
}

@Processor(SYNC_QUEUES.OUTBOUND_INVENTORY, { concurrency: 5 })
export class OutboundSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundSyncProcessor.name);

  constructor(
    @Inject('ADAPTOR_REGISTRY')
    private readonly adaptors: Map<string, PartnerAdaptor>,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    super();
  }

  async process(job: Job<OutboundInventoryJobData>): Promise<unknown> {
    const { syncJobId, partnerSlug, update } = job.data;
    const adaptor = this.adaptors.get(partnerSlug);

    if (!adaptor) {
      throw new Error(`Adaptor not found for partner slug: ${partnerSlug}`);
    }

    // 1. Circuit Breaker validation
    const allowed = await this.circuitBreaker.canExecute(partnerSlug);
    if (!allowed) {
      throw new Error(`Circuit OPEN for partner ${partnerSlug}. Delaying/failing sync job execution.`);
    }

    // 2. Mark database record as PROCESSING
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.PROCESSING,
        attempts: job.attemptsMade + 1,
      },
    });

    try {
      // 3. Dispatch to partner adaptor
      const response = await adaptor.pushInventory(update);

      // 4. Record circuit breaker success & mark job COMPLETED
      await this.circuitBreaker.recordSuccess(partnerSlug);
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: SyncJobStatus.COMPLETED,
          lastError: null,
        },
      });

      this.logger.log(`Outbound sync completed for ${partnerSlug} (Job ${syncJobId})`);
      return response;
    } catch (error: any) {
      // Record failure with circuit breaker
      await this.circuitBreaker.recordFailure(partnerSlug);

      // Persist interim error details for visibility
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: SyncJobStatus.FAILED,
          lastError: error.message || 'Unknown network error',
        },
      });

      this.logger.warn(
        `Sync attempt ${job.attemptsMade + 1} failed for partner ${partnerSlug}: ${error.message}`,
      );
      throw error; // Re-throw to trigger BullMQ exponential backoff
    }
  }

  /**
   * DLQ Hook: Triggered once all 5 retry attempts are exhausted[cite: 1].
   */
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<OutboundInventoryJobData>, error: Error) {
    if (job.attemptsMade >= (job.opts.attempts || 5)) {
      this.logger.error(
        `CRITICAL: Job ${job.id} for partner ${job.data.partnerSlug} exceeded all retry attempts. Moving to DEAD_LETTER.`,
      );

      await prisma.syncJob.update({
        where: { id: job.data.syncJobId },
        data: {
          status: SyncJobStatus.DEAD_LETTER,
          lastError: `Exhausted retries: ${error.message}`,
        },
      });
    }
  }
}