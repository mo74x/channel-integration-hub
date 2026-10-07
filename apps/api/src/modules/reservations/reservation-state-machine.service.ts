import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { ReservationStatus } from '@cih/shared';
import { prisma } from '@cih/database';
import { InventoryService } from '../inventory/inventory.service.js';

export const RESERVATION_INVENTORY_CHANGED_EVENT = 'reservation.inventory-changed';
export const domainEventEmitter = new EventEmitter();
domainEventEmitter.setMaxListeners(100);

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

export interface ReservationInventoryChangedEvent {
  reservationId: string;
  partnerId: string;
  propertyId: string;
  inventoryUnitId: string;
  inventoryUnitCode?: string;
  action: 'CONFIRMED' | 'CANCELLED';
  unitsBooked: number;
  checkInDate: string;
  checkOutDate: string;
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

  constructor(
    private readonly inventoryService: InventoryService,
    @Optional() private readonly events: EventEmitter = domainEventEmitter,
  ) {}

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

        let created;
        try {
          created = await prisma.reservation.create({
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
        } catch (insertError) {
          // Restore booked inventory if reservation insertion fails
          this.logger.error(
            `Failed inserting reservation ${req.externalBookingId} after inventory was booked. Restoring inventory...`,
            insertError,
          );
          await this.inventoryService.restoreInventoryUnits(
            bookingResult.inventoryUnitId,
            req.checkInDate,
            req.checkOutDate,
            req.unitsBooked,
          );
          throw insertError;
        }

        // Emit domain event for confirmed reservation
        this.events.emit(RESERVATION_INVENTORY_CHANGED_EVENT, {
          reservationId: created.id,
          partnerId: created.partnerId,
          propertyId: created.propertyId,
          inventoryUnitId: created.inventoryUnitId,
          inventoryUnitCode: req.inventoryUnitCode,
          action: 'CONFIRMED',
          unitsBooked: created.unitsBooked,
          checkInDate: req.checkInDate,
          checkOutDate: req.checkOutDate,
        });

        return created;
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

      const updated = await prisma.reservation.update({
        where: { id: existing.id },
        data: {
          status: 'CANCELLED',
          version: { increment: 1 },
          rawPayload: (req.rawPayload as object) ?? existing.rawPayload,
        },
      });

      // Emit domain event for cancelled reservation
      this.events.emit(RESERVATION_INVENTORY_CHANGED_EVENT, {
        reservationId: updated.id,
        partnerId: updated.partnerId,
        propertyId: updated.propertyId,
        inventoryUnitId: updated.inventoryUnitId,
        inventoryUnitCode: req.inventoryUnitCode,
        action: 'CANCELLED',
        unitsBooked: updated.unitsBooked,
        checkInDate: existing.checkInDate.toISOString().slice(0, 10),
        checkOutDate: existing.checkOutDate.toISOString().slice(0, 10),
      });

      return updated;
    }

    // 5. Handle PENDING -> CONFIRMED transition
    if (
      (existing.status as unknown as ReservationStatus) === ReservationStatus.PENDING &&
      req.targetStatus === ReservationStatus.CONFIRMED
    ) {
      const checkInStr = req.checkInDate || existing.checkInDate.toISOString().slice(0, 10);
      const checkOutStr = req.checkOutDate || existing.checkOutDate.toISOString().slice(0, 10);
      const units = req.unitsBooked || existing.unitsBooked;

      const bookingResult = await this.inventoryService.bookInventoryUnits(
        existing.propertyId,
        req.inventoryUnitCode,
        checkInStr,
        checkOutStr,
        units,
      );

      let updated;
      try {
        updated = await prisma.reservation.update({
          where: { id: existing.id },
          data: {
            status: 'CONFIRMED',
            version: { increment: 1 },
            rawPayload: (req.rawPayload as object) ?? existing.rawPayload,
          },
        });
      } catch (updateError) {
        await this.inventoryService.restoreInventoryUnits(
          bookingResult.inventoryUnitId,
          checkInStr,
          checkOutStr,
          units,
        );
        throw updateError;
      }

      this.events.emit(RESERVATION_INVENTORY_CHANGED_EVENT, {
        reservationId: updated.id,
        partnerId: updated.partnerId,
        propertyId: updated.propertyId,
        inventoryUnitId: updated.inventoryUnitId,
        inventoryUnitCode: req.inventoryUnitCode,
        action: 'CONFIRMED',
        unitsBooked: updated.unitsBooked,
        checkInDate: checkInStr,
        checkOutDate: checkOutStr,
      });

      return updated;
    }

    // 6. Apply any other legal transition
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