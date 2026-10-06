import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { prisma, SyncJobType, SyncJobStatus } from '@cih/database';
import { SYNC_QUEUES } from '../sync.constants.js';
import { PartnerAdaptor } from '../../adaptors/partner-adaptor.interface.js';
import { ReservationStateMachineService } from '../../reservations/reservation-state-machine.service.js';

@Processor(SYNC_QUEUES.POLLING_RESERVATIONS, { concurrency: 1 })
export class PollingProcessor extends WorkerHost {
  private readonly logger = new Logger(PollingProcessor.name);

  constructor(
    @Inject('ADAPTOR_REGISTRY')
    private readonly adaptors: Map<string, PartnerAdaptor>,
    private readonly stateMachineService: ReservationStateMachineService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const partnerSlug = 'partner_b';
    const adaptor = this.adaptors.get(partnerSlug);
    if (!adaptor) return;

    const partner = await prisma.partner.findUnique({
      where: { slug: partnerSlug },
    });
    if (!partner || partner.status !== 'ACTIVE') return;

    this.logger.log(`Running scheduled reservations poll for ${partner.name}...`);

    // 1. Fetch property mapping for Partner B
    const mappings = await prisma.propertyPartnerMapping.findMany({
      where: { partnerId: partner.id },
    });

    for (const mapping of mappings) {
      try {
        // Query changes in the last 2 hours
        const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const remoteReservations = await adaptor.pullReservations(mapping.externalPropertyId, since);

        for (const remote of remoteReservations) {
          // Ingest polled reservations through state machine
          await this.stateMachineService.processTransition({
            partnerId: partner.id,
            externalBookingId: remote.externalBookingId,
            targetStatus: remote.status,
            propertyId: mapping.propertyId,
            inventoryUnitCode: remote.inventoryUnitCode,
            checkInDate: remote.checkInDate,
            checkOutDate: remote.checkOutDate,
            unitsBooked: remote.unitsBooked,
            guestName: remote.guestName,
            guestEmail: remote.guestEmail,
            totalPriceCents: remote.totalPriceCents,
            currency: remote.currency,
            rawPayload: remote.metadata,
          });
        }

        // Record successful poll execution
        await prisma.syncJob.create({
          data: {
            partnerId: partner.id,
            jobType: SyncJobType.SCHEDULED_POLL,
            entityType: 'RESERVATION',
            status: SyncJobStatus.COMPLETED,
            payload: { pulledCount: remoteReservations.length, externalPropertyId: mapping.externalPropertyId },
          },
        });
      } catch (error: any) {
        this.logger.error(`Error polling Partner B for property ${mapping.propertyId}:`, error);
        await prisma.syncJob.create({
          data: {
            partnerId: partner.id,
            jobType: SyncJobType.SCHEDULED_POLL,
            entityType: 'RESERVATION',
            status: SyncJobStatus.FAILED,
            lastError: error.message,
            payload: { externalPropertyId: mapping.externalPropertyId },
          },
        });
      }
    }
  }
}