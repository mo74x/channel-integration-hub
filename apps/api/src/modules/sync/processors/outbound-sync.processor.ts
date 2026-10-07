import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, UnrecoverableError, DelayedError } from 'bullmq';
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
      this.logger.warn(
        `Circuit OPEN for partner ${partnerSlug}. Delaying sync job ${syncJobId} instead of burning a retry.`,
      );
      const delayMs = 10000;
      if (typeof job.moveToDelayed === 'function') {
        await job.moveToDelayed(Date.now() + delayMs, job.token);
      }
      throw new DelayedError();
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
      const status =
        error?.status ??
        error?.statusCode ??
        error?.response?.status ??
        (typeof error?.message === 'string' && error.message.match(/status (\d{3})/i)
          ? parseInt(error.message.match(/status (\d{3})/i)![1], 10)
          : undefined);

      const is4xx = typeof status === 'number' && status >= 400 && status < 500;

      if (is4xx) {
        this.logger.error(
          `Unrecoverable 4xx client error (${status}) from partner ${partnerSlug} for Job ${syncJobId}: ${error.message}. Moving straight to DLQ without tripping circuit.`,
        );

        // Update database record straight to DLQ (DEAD_LETTER) without tripping the circuit
        await prisma.syncJob.update({
          where: { id: syncJobId },
          data: {
            status: SyncJobStatus.DEAD_LETTER,
            lastError: `4xx Unrecoverable (${status}): ${error.message || 'Client error'}`,
          },
        });

        // Throw BullMQ UnrecoverableError so BullMQ does not retry
        throw new UnrecoverableError(
          `4xx client error (${status}) from ${partnerSlug}: ${error.message}`,
        );
      }

      // Record failure with circuit breaker for non-4xx errors (transient / 5xx / timeouts)
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
   * DLQ Hook: Triggered when job fails permanently (exhausted retries or UnrecoverableError).
   */
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<OutboundInventoryJobData>, error: Error) {
    const isUnrecoverable =
      error instanceof UnrecoverableError || error?.name === 'UnrecoverableError';
    const exhaustedRetries = job.attemptsMade >= (job.opts?.attempts || 5);

    if (isUnrecoverable || exhaustedRetries) {
      this.logger.error(
        `CRITICAL: Job ${job.id} for partner ${job.data?.partnerSlug} failed (${isUnrecoverable ? 'UnrecoverableError' : 'Exhausted retries'}). Moving to DEAD_LETTER.`,
      );

      if (job.data?.syncJobId) {
        await prisma.syncJob.update({
          where: { id: job.data.syncJobId },
          data: {
            status: SyncJobStatus.DEAD_LETTER,
            lastError: isUnrecoverable
              ? `Unrecoverable error: ${error.message}`
              : `Exhausted retries: ${error.message}`,
          },
        });
      }
    }
  }
}
