import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { prisma } from '@cih/database';
import { CanonicalInventoryPushPayload } from '@cih/shared';
import { SyncService } from './sync.service.js';
import {
  domainEventEmitter,
  ReservationInventoryChangedEvent,
  RESERVATION_INVENTORY_CHANGED_EVENT,
} from '../reservations/reservation-state-machine.service.js';

@Injectable()
export class AvailabilityFanoutListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvailabilityFanoutListener.name);

  private readonly boundHandler = (event: ReservationInventoryChangedEvent) => {
    this.handleInventoryChanged(event).catch((err) => {
      this.logger.error(
        `Failed to fan out availability for reservation ${event?.reservationId}: ${err.message}`,
        err.stack,
      );
    });
  };

  constructor(
    private readonly syncService: SyncService,
    @Optional()
    @Inject('DOMAIN_EVENT_EMITTER')
    private readonly events: EventEmitter = domainEventEmitter,
  ) {}

  onModuleInit() {
    this.events.on(RESERVATION_INVENTORY_CHANGED_EVENT, this.boundHandler);
    this.logger.log(`AvailabilityFanoutListener subscribed to ${RESERVATION_INVENTORY_CHANGED_EVENT}`);
  }

  onModuleDestroy() {
    this.events.off(RESERVATION_INVENTORY_CHANGED_EVENT, this.boundHandler);
    this.logger.log(`AvailabilityFanoutListener unsubscribed from ${RESERVATION_INVENTORY_CHANGED_EVENT}`);
  }

  /**
   * Reads updated calendar rows for the reservation stay window and broadcasts
   * the canonical inventory updates to all active partners, skipping the originating partner.
   */
  async handleInventoryChanged(event: ReservationInventoryChangedEvent): Promise<void> {
    if (!event || !event.inventoryUnitId || !event.checkInDate || !event.checkOutDate) {
      this.logger.warn(`Received malformed inventory-changed event: ${JSON.stringify(event)}`);
      return;
    }

    this.logger.log(
      `Processing availability fan-out for reservation ${event.reservationId} (${event.action}) on unit ${event.inventoryUnitId}`,
    );

    const checkInStr =
      typeof event.checkInDate === 'string'
        ? event.checkInDate.slice(0, 10)
        : (event.checkInDate as Date).toISOString().slice(0, 10);
    const checkOutStr =
      typeof event.checkOutDate === 'string'
        ? event.checkOutDate.slice(0, 10)
        : (event.checkOutDate as Date).toISOString().slice(0, 10);

    const startDate = new Date(`${checkInStr}T00:00:00.000Z`);
    const endDate = new Date(`${checkOutStr}T00:00:00.000Z`);

    // Fetch affected calendar rows along with associated inventory unit metadata
    const calendarRows = await prisma.inventoryCalendar.findMany({
      where: {
        inventoryUnitId: event.inventoryUnitId,
        date: {
          gte: startDate,
          lt: endDate,
        },
      },
      include: {
        inventoryUnit: true,
      },
      orderBy: {
        date: 'asc',
      },
    });

    if (calendarRows.length === 0) {
      this.logger.warn(
        `No calendar rows found for inventoryUnitId ${event.inventoryUnitId} between ${checkInStr} and ${checkOutStr}`,
      );
      return;
    }

    // Resolve inventoryUnitCode if not eager-loaded in calendar rows
    let fallbackUnitCode = event.inventoryUnitCode;
    let fallbackPropertyId = event.propertyId;

    if (!calendarRows[0]?.inventoryUnit && (!fallbackUnitCode || !fallbackPropertyId)) {
      const unit = await prisma.inventoryUnit.findUnique({
        where: { id: event.inventoryUnitId },
      });
      if (unit) {
        fallbackUnitCode = fallbackUnitCode || unit.externalCode;
        fallbackPropertyId = fallbackPropertyId || unit.propertyId;
      }
    }

    for (const row of calendarRows) {
      const rowDate =
        row.date instanceof Date
          ? row.date.toISOString().slice(0, 10)
          : String(row.date).slice(0, 10);

      const payload: CanonicalInventoryPushPayload = {
        propertyId: row.inventoryUnit?.propertyId || fallbackPropertyId,
        inventoryUnitCode: row.inventoryUnit?.externalCode || fallbackUnitCode || '',
        date: rowDate,
        availableUnits: row.availableUnits,
        priceInCents: row.priceInCents,
      };

      // Broadcast update across active partners, skipping originating partner to prevent echo loops
      await this.syncService.broadcastInventoryUpdate(payload, event.partnerId);
    }

    this.logger.log(
      `Broadcasted ${calendarRows.length} inventory calendar updates for unit ${event.inventoryUnitId} (skipped partner: ${event.partnerId})`,
    );
  }
}
