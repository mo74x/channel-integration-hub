import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { prisma, SyncJobStatus, SyncJobType } from '@cih/database';
import { CircuitBreakerService } from '../../common/circuit-breaker/circuit-breaker.service.js';
import { SYNC_QUEUES, SYNC_JOBS } from '../sync/sync.constants.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly reconciliationService: ReconciliationService,
    @InjectQueue(SYNC_QUEUES.OUTBOUND_INVENTORY)
    private readonly inventoryQueue: Queue,
  ) {}

  /**
   * Retrieves all partner connections along with real-time circuit states.
   */
  async getPartnersOverview() {
    const partners = await prisma.partner.findMany({
      orderBy: { name: 'asc' },
    });

    const enriched = await Promise.all(
      partners.map(async (partner) => {
        const circuit = await this.circuitBreaker.getStatus(partner.slug);
        const failedJobsCount = await prisma.syncJob.count({
          where: {
            partnerId: partner.id,
            status: { in: [SyncJobStatus.FAILED, SyncJobStatus.DEAD_LETTER] },
          },
        });

        return {
          id: partner.id,
          slug: partner.slug,
          name: partner.name,
          authType: partner.authType,
          status: partner.status,
          circuitState: circuit.state,
          consecutiveFailures: circuit.consecutiveFailures,
          unresolvedFailedJobs: failedJobsCount,
        };
      }),
    );

    return enriched;
  }

  /**
   * Returns list of sync jobs with optional status filter.
   */
  async getSyncJobs(status?: SyncJobStatus, take = 50) {
    return prisma.syncJob.findMany({
      where: status ? { status } : undefined,
      include: { partner: { select: { slug: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Replays a failed or dead-letter sync job by resetting attempts and re-enqueueing into BullMQ.
   */
  async replaySyncJob(jobId: string) {
    const syncJob = await prisma.syncJob.findUnique({
      where: { id: jobId },
      include: { partner: true },
    });

    if (!syncJob) {
      throw new NotFoundException(`Sync job ${jobId} not found`);
    }

    if (syncJob.status !== SyncJobStatus.FAILED && syncJob.status !== SyncJobStatus.DEAD_LETTER) {
      throw new BadRequestException(`Cannot replay a job in status '${syncJob.status}'`);
    }

    // Reset status to QUEUED
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: SyncJobStatus.QUEUED,
        lastError: null,
      },
    });

    // Re-dispatch into the appropriate BullMQ queue based on jobType
    if (syncJob.jobType === SyncJobType.OUTBOUND_PUSH) {
      await this.inventoryQueue.add(
        SYNC_JOBS.PUSH_INVENTORY_SLOT,
        {
          syncJobId: syncJob.id,
          partnerSlug: syncJob.partner.slug,
          update: syncJob.payload,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    this.logger.log(`Manual replay enqueued for SyncJob: ${jobId}`);
    return { success: true, message: `Job ${jobId} re-enqueued successfully.` };
  }

  /**
   * Fetches drift history captured by reconciliation runs.
   */
  async getReconciliationLogs(take = 50) {
    return prisma.reconciliationLog.findMany({
      include: { partner: { select: { slug: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * Triggers an immediate drift reconciliation sweep for a partner.
   */
  async triggerReconciliation(partnerSlug: string) {
    const driftCount = await this.reconciliationService.reconcilePartnerReservations(partnerSlug);
    return { partnerSlug, driftDetected: driftCount };
  }

  /**
   * Resolves a drift log by applying operator resolution action.
   */
  async resolveReconciliationLog(
    id: string,
    action: 'ACCEPT_PARTNER' | 'KEEP_CANONICAL' | 'DISMISS',
  ) {
    return this.reconciliationService.resolveDriftLog(id, action);
  }
}