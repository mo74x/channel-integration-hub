import { Inject, Injectable, Logger } from '@nestjs/common';
import { prisma, DriftResolution, Prisma } from '@cih/database';
import { PartnerAdaptor } from '../adaptors/partner-adaptor.interface.js';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject('ADAPTOR_REGISTRY')
    private readonly adaptors: Map<string, PartnerAdaptor>,
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

    this.logger.log(`Reconciliation finished for ${partnerSlug}. Total drift items identified: ${driftCount}`);
    return driftCount;
  }
}