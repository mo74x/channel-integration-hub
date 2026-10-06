import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { prisma, SyncJobType } from '@cih/database';
import { CanonicalInventoryPushPayload } from '@cih/shared';
import { SYNC_QUEUES, SYNC_JOBS } from './sync.constants.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectQueue(SYNC_QUEUES.OUTBOUND_INVENTORY)
    private readonly outboundInventoryQueue: Queue,
  ) {}

  /**
   * Dispatches inventory push jobs across all active partner adaptors.
   */
  async broadcastInventoryUpdate(update: CanonicalInventoryPushPayload): Promise<void> {
    const activePartners = await prisma.partner.findMany({
      where: { status: 'ACTIVE' },
    });

    for (const partner of activePartners) {
      // Audit trail: Record pending sync job in database
      const syncRecord = await prisma.syncJob.create({
        data: {
          partnerId: partner.id,
          jobType: SyncJobType.OUTBOUND_PUSH,
          entityType: 'INVENTORY_CALENDAR',
          entityId: `${update.inventoryUnitCode}:${update.date}`,
          status: 'QUEUED',
          maxRetries: 5,
          payload: update as object,
        },
      });

      // Queue BullMQ job with backoff and retry policy
      await this.outboundInventoryQueue.add(
        SYNC_JOBS.PUSH_INVENTORY_SLOT,
        {
          syncJobId: syncRecord.id,
          partnerSlug: partner.slug,
          update,
        },
        {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000, // 2s, 4s, 8s, 16s, 32s
          },
          removeOnComplete: true,
          removeOnFail: false, // Keep in BullMQ failed state for DLQ inspection
        },
      );

      this.logger.log(`Enqueued inventory sync for partner ${partner.slug} (Job: ${syncRecord.id})`);
    }
  }
}