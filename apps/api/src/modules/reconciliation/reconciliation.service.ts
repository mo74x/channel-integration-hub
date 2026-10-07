import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { prisma, DriftResolution, Prisma } from '@cih/database';
import { ReservationStatus } from '@cih/shared';
import { PartnerAdaptor } from '../adaptors/partner-adaptor.interface.js';
import {
  ReservationStateMachineService,
  TransitionRequest,
} from '../reservations/reservation-state-machine.service.js';

export type DriftResolutionAction = 'ACCEPT_PARTNER' | 'KEEP_CANONICAL' | 'DISMISS';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject('ADAPTOR_REGISTRY')
    private readonly adaptors: Map<string, PartnerAdaptor>,
    @Optional()
    private readonly stateMachineService?: ReservationStateMachineService,
  ) {}

  /**
   * Compares internal reservation status against external partner systems and logs/repairs drift[cite: 1].
   */
  async reconcilePartnerReservations(partnerSlug: string): Promise<number> {
    const adaptor = this.adaptors.get(partnerSlug);
    if (!adaptor) return 0;

    const partner = await prisma.partner.findUnique({
      where: { slug: partnerSlug },
    });
    if (!partner) return 0;

    this.logger.log(`Starting automated drift reconciliation for ${partner.name}...`);
    let driftCount = 0;

    const mappings = await prisma.propertyPartnerMapping.findMany({
      where: { partnerId: partner.id },
    });

    for (const mapping of mappings) {
      // 1. Fetch remote external partner state
      const remoteRecords = await adaptor.pullReservations(mapping.externalPropertyId);

      for (const remote of remoteRecords) {
        // 2. Fetch canonical database state
        const canonical = await prisma.reservation.findUnique({
          where: {
            partnerId_externalBookingId: {
              partnerId: partner.id,
              externalBookingId: remote.externalBookingId,
            },
          },
        });

        if (!canonical) {
          // Drift: Reservation exists on partner side but missing locally
          driftCount++;
          await prisma.reconciliationLog.create({
            data: {
              partnerId: partner.id,
              entityType: 'RESERVATION',
              entityId: remote.externalBookingId,
              canonicalData: {},
              partnerData: remote as unknown as Prisma.InputJsonValue,
              driftDetail: {
                issue: 'MISSING_IN_CANONICAL_DB',
                details: remote,
              } as unknown as Prisma.InputJsonValue,
              resolution: DriftResolution.FLAGGED_FOR_REVIEW,
            },
          });
          continue;
        }

        // 3. Drift: Status mismatch (e.g., Partner reported CANCELLED, DB is CONFIRMED)[cite: 1]
        if (canonical.status !== (remote.status as any)) {
          driftCount++;
          const driftDetail = {
            issue: 'STATUS_MISMATCH',
            canonicalStatus: canonical.status,
            partnerStatus: remote.status,
          };

          this.logger.warn(
            `Drift detected on reservation ${canonical.externalBookingId}: DB(${canonical.status}) != Partner(${remote.status})`,
          );

          // Apply "Canonical DB Wins" or auto-correct policy[cite: 1]
          await prisma.reconciliationLog.create({
            data: {
              partnerId: partner.id,
              entityType: 'RESERVATION',
              entityId: canonical.id,
              canonicalData: { status: canonical.status },
              partnerData: { status: remote.status },
              driftDetail,
              resolution: DriftResolution.AUTO_CORRECTED,
              resolvedAt: new Date(),
            },
          });
        }
      }
    }

    this.logger.log(
      `Reconciliation finished for ${partnerSlug}. Total drift items identified: ${driftCount}`,
    );
    return driftCount;
  }

  /**
   * Resolves a drift reconciliation log.
   * - DISMISS: Marks log as dismissed.
   * - KEEP_CANONICAL: Retains canonical state as the source of truth.
   * - ACCEPT_PARTNER: Applies partner's remote state through the reservation state machine.
   */
  async resolveDriftLog(logId: string, action: DriftResolutionAction) {
    const validActions: DriftResolutionAction[] = ['ACCEPT_PARTNER', 'KEEP_CANONICAL', 'DISMISS'];

    if (!validActions.includes(action)) {
      throw new BadRequestException(
        `Invalid action "${action}". Allowed: ACCEPT_PARTNER, KEEP_CANONICAL, DISMISS`,
      );
    }

    const log = await prisma.reconciliationLog.findUnique({
      where: { id: logId },
      include: { partner: true },
    });

    if (!log) {
      throw new NotFoundException(`Reconciliation log "${logId}" not found`);
    }

    if (action === 'DISMISS') {
      const updatedLog = await prisma.reconciliationLog.update({
        where: { id: logId },
        data: {
          resolution: DriftResolution.DISMISSED,
          resolvedAt: new Date(),
          driftDetail: {
            ...(typeof log.driftDetail === 'object' && log.driftDetail !== null
              ? (log.driftDetail as Record<string, unknown>)
              : {}),
            resolvedAction: 'DISMISS',
            resolvedAt: new Date().toISOString(),
          },
        },
      });

      this.logger.log(`Reconciliation log ${logId} dismissed.`);
      return {
        success: true,
        action: 'DISMISS',
        log: updatedLog,
      };
    }

    if (action === 'KEEP_CANONICAL') {
      const updatedLog = await prisma.reconciliationLog.update({
        where: { id: logId },
        data: {
          resolution: DriftResolution.AUTO_CORRECTED,
          resolvedAt: new Date(),
          driftDetail: {
            ...(typeof log.driftDetail === 'object' && log.driftDetail !== null
              ? (log.driftDetail as Record<string, unknown>)
              : {}),
            resolvedAction: 'KEEP_CANONICAL',
            resolvedAt: new Date().toISOString(),
          },
        },
      });

      this.logger.log(`Reconciliation log ${logId} resolved by keeping canonical state.`);
      return {
        success: true,
        action: 'KEEP_CANONICAL',
        log: updatedLog,
      };
    }

    // action === 'ACCEPT_PARTNER': Apply partner changes through state machine
    if (!this.stateMachineService) {
      throw new BadRequestException('ReservationStateMachineService is not available');
    }

    const partnerData = (
      typeof log.partnerData === 'object' && log.partnerData !== null ? log.partnerData : {}
    ) as Record<string, any>;

    const driftDetail = (
      typeof log.driftDetail === 'object' && log.driftDetail !== null ? log.driftDetail : {}
    ) as Record<string, any>;

    // 1. Locate reservation (by ID or external booking reference)
    let reservation = await prisma.reservation.findUnique({
      where: { id: log.entityId },
      include: { inventoryUnit: true },
    });

    if (!reservation) {
      reservation = await prisma.reservation.findUnique({
        where: {
          partnerId_externalBookingId: {
            partnerId: log.partnerId,
            externalBookingId: log.entityId,
          },
        },
        include: { inventoryUnit: true },
      });
    }

    let transitionResult;

    if (reservation) {
      // Status mismatch on existing reservation: transition to target partner status
      const targetStatus =
        partnerData.status || driftDetail.partnerStatus || driftDetail.details?.status;

      if (!targetStatus) {
        throw new BadRequestException(
          'Cannot resolve with ACCEPT_PARTNER: target partner status is missing in log',
        );
      }

      const transitionReq: TransitionRequest = {
        partnerId: reservation.partnerId,
        externalBookingId: reservation.externalBookingId,
        targetStatus: targetStatus as ReservationStatus,
        propertyId: reservation.propertyId,
        inventoryUnitCode:
          reservation.inventoryUnit?.externalCode || partnerData.inventoryUnitCode || '',
        checkInDate: reservation.checkInDate.toISOString().slice(0, 10),
        checkOutDate: reservation.checkOutDate.toISOString().slice(0, 10),
        unitsBooked: reservation.unitsBooked,
        guestName: reservation.guestName,
        guestEmail: reservation.guestEmail || undefined,
        totalPriceCents: reservation.totalPriceCents,
        currency: reservation.currency,
        rawPayload: partnerData,
      };

      transitionResult = await this.stateMachineService.processTransition(transitionReq);
    } else {
      // Reservation missing locally: ingest remote record from log
      const remote =
        (partnerData.externalBookingId ? partnerData : driftDetail.details) || partnerData;

      if (!remote.status || !remote.propertyId || !remote.inventoryUnitCode) {
        throw new BadRequestException(
          'Cannot resolve with ACCEPT_PARTNER: incomplete partner reservation payload in log',
        );
      }

      const checkInStr =
        typeof remote.checkInDate === 'string'
          ? remote.checkInDate.slice(0, 10)
          : new Date(remote.checkInDate).toISOString().slice(0, 10);
      const checkOutStr =
        typeof remote.checkOutDate === 'string'
          ? remote.checkOutDate.slice(0, 10)
          : new Date(remote.checkOutDate).toISOString().slice(0, 10);

      const transitionReq: TransitionRequest = {
        partnerId: log.partnerId,
        externalBookingId: remote.externalBookingId || log.entityId,
        targetStatus: remote.status as ReservationStatus,
        propertyId: remote.propertyId,
        inventoryUnitCode: remote.inventoryUnitCode,
        checkInDate: checkInStr,
        checkOutDate: checkOutStr,
        unitsBooked: remote.unitsBooked || 1,
        guestName: remote.guestName || 'Partner Guest',
        guestEmail: remote.guestEmail || undefined,
        totalPriceCents: remote.totalPriceCents || 0,
        currency: remote.currency || 'USD',
        rawPayload: remote,
      };

      transitionResult = await this.stateMachineService.processTransition(transitionReq);
    }

    const updatedLog = await prisma.reconciliationLog.update({
      where: { id: logId },
      data: {
        resolution: DriftResolution.AUTO_CORRECTED,
        resolvedAt: new Date(),
        driftDetail: {
          ...(typeof log.driftDetail === 'object' && log.driftDetail !== null
            ? (log.driftDetail as Record<string, unknown>)
            : {}),
          resolvedAction: 'ACCEPT_PARTNER',
          appliedReservationId: transitionResult.id,
          appliedStatus: transitionResult.status,
          resolvedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.log(
      `Reconciliation log ${logId} resolved via ACCEPT_PARTNER through state machine (Reservation: ${transitionResult.id}, Status: ${transitionResult.status})`,
    );

    return {
      success: true,
      action: 'ACCEPT_PARTNER',
      reservation: transitionResult,
      log: updatedLog,
    };
  }
}
