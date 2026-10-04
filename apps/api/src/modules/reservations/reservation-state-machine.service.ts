import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ReservationStatus } from '@cih/shared';
import { prisma } from '@cih/database';
import { InventoryService } from '../inventory/inventory.service.js';

export interface TransitionRequest {
  partnerId: string;
  externalBookingId: string;
  targetStatus: ReservationStatus;
  propertyId: string;
  inventoryUnitCode: string;
  checkInDate: string;
  checkOutDate: string;
  unitsBooked: number;
  guestName: string;
  guestEmail?: string;
  totalPriceCents?: number;
  currency?: string;
  rawPayload?: unknown;
}

@Injectable()
export class ReservationStateMachineService {
  private readonly logger = new Logger(ReservationStateMachineService.name);

  private readonly allowedTransitions: Record<ReservationStatus, ReservationStatus[]> = {
    [ReservationStatus.PENDING]: [
      ReservationStatus.CONFIRMED,
      ReservationStatus.REJECTED,
      ReservationStatus.CANCELLED,
    ],
    [ReservationStatus.CONFIRMED]: [ReservationStatus.CANCELLED],
    [ReservationStatus.CANCELLED]: [], // Terminal state
    [ReservationStatus.REJECTED]: [],  // Terminal state
  };

  constructor(private readonly inventoryService: InventoryService) {}

  async processTransition(req: TransitionRequest) {
    const existing = await prisma.reservation.findUnique({
      where: {
        partnerId_externalBookingId: {
          partnerId: req.partnerId,
          externalBookingId: req.externalBookingId,
        },
      },
    });

    // 1. Idempotency match: Entity already reached requested state
    if (existing && (existing.status as unknown as ReservationStatus) === req.targetStatus) {
      this.logger.log(
        `Idempotent no-op for reservation ${req.externalBookingId}: already in state ${req.targetStatus}`,
      );
      return existing;
    }

    // 2. Out-of-order protection: Reject invalid state transitions
    if (existing) {
      const current = existing.status as unknown as ReservationStatus;
      const validNextStates = this.allowedTransitions[current] || [];

      if (!validNextStates.includes(req.targetStatus)) {
        throw new BadRequestException(
          `Invalid state transition: cannot transition reservation from ${current} to ${req.targetStatus}`,
        );
      }
    }

    // 3. New reservation request
    if (!existing) {
      if (req.targetStatus === ReservationStatus.CONFIRMED) {
        const bookingResult = await this.inventoryService.bookInventoryUnits(
          req.propertyId,
          req.inventoryUnitCode,
          req.checkInDate,
          req.checkOutDate,
          req.unitsBooked,
        );

        return await prisma.reservation.create({
          data: {
            partnerId: req.partnerId,
            externalBookingId: req.externalBookingId,
            propertyId: req.propertyId,
            inventoryUnitId: bookingResult.inventoryUnitId,
            status: 'CONFIRMED',
            checkInDate: new Date(req.checkInDate),
            checkOutDate: new Date(req.checkOutDate),
            unitsBooked: req.unitsBooked,
            guestName: req.guestName,
            guestEmail: req.guestEmail,
            totalPriceCents: req.totalPriceCents ?? bookingResult.totalPriceCents,
            currency: req.currency || 'USD',
            rawPayload: req.rawPayload as object,
            version: 1,
          },
        });
      }

      // Record non-confirmed initial bookings without decrementing inventory
      const unit = await prisma.inventoryUnit.findUniqueOrThrow({
        where: {
          propertyId_externalCode: {
            propertyId: req.propertyId,
            externalCode: req.inventoryUnitCode,
          },
        },
      });

      return await prisma.reservation.create({
        data: {
          partnerId: req.partnerId,
          externalBookingId: req.externalBookingId,
          propertyId: req.propertyId,
          inventoryUnitId: unit.id,
          status: req.targetStatus as any,
          checkInDate: new Date(req.checkInDate),
          checkOutDate: new Date(req.checkOutDate),
          unitsBooked: req.unitsBooked,
          guestName: req.guestName,
          guestEmail: req.guestEmail,
          totalPriceCents: req.totalPriceCents ?? 0,
          currency: req.currency || 'USD',
          rawPayload: req.rawPayload as object,
          version: 1,
        },
      });
    }

    // 4. Handle CONFIRMED -> CANCELLED: restore allocated calendar capacity
    if (
      (existing.status as unknown as ReservationStatus) === ReservationStatus.CONFIRMED &&
      req.targetStatus === ReservationStatus.CANCELLED
    ) {
      await this.inventoryService.restoreInventoryUnits(
        existing.inventoryUnitId,
        existing.checkInDate.toISOString().slice(0, 10),
        existing.checkOutDate.toISOString().slice(0, 10),
        existing.unitsBooked,
      );

      return await prisma.reservation.update({
        where: { id: existing.id },
        data: {
          status: 'CANCELLED',
          version: { increment: 1 },
          rawPayload: (req.rawPayload as object) ?? existing.rawPayload,
        },
      });
    }

    // 5. Apply any other legal transition
    return await prisma.reservation.update({
      where: { id: existing.id },
      data: {
        status: req.targetStatus as any,
        version: { increment: 1 },
        rawPayload: (req.rawPayload as object) ?? existing.rawPayload,
      },
    });
  }
}