import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { prisma } from '@cih/database';
import { CanonicalInventoryPushPayload } from '@cih/shared';
import { DistributedLockService } from '../../common/redis/distributed-lock.service.js';
import { SyncService } from '../sync/sync.service.js';

export interface CalendarUpdateEntry {
  date: string;
  availableUnits?: number;
  priceInCents?: number;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly lockService: DistributedLockService,
    @Optional()
    @Inject(forwardRef(() => SyncService))
    private readonly syncService?: SyncService,
  ) {}

  private generateDateRange(checkIn: string, checkOut: string): Date[] {
    const dates: Date[] = [];
    const current = new Date(`${checkIn}T00:00:00.000Z`);
    const end = new Date(`${checkOut}T00:00:00.000Z`);

    if (current >= end) {
      throw new BadRequestException('Check-out date must be strictly after check-in date');
    }

    while (current < end) {
      dates.push(new Date(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
  }

  /**
   * Executes an action under distributed locks for all dates in the range,
   * sorted lexicographically to prevent deadlocks across concurrent requests.
   */
  private async withInventoryLocks<T>(
    inventoryUnitId: string,
    dates: Date[],
    action: () => Promise<T>,
  ): Promise<T> {
    const lockKeys = dates
      .map((d) => `inventory:${inventoryUnitId}:${d.toISOString().slice(0, 10)}`)
      .sort();

    const acquiredLocks: { token: string; key: string }[] = [];

    try {
      for (const key of lockKeys) {
        const lock = await this.lockService.acquireLock(key, 8000, 12, 100);
        if (!lock) {
          throw new BadRequestException(
            `Concurrency timeout while locking inventory for unit ${inventoryUnitId}`,
          );
        }
        acquiredLocks.push(lock);
      }

      return await action();
    } finally {
      // Release in reverse acquisition order
      for (const lock of acquiredLocks.reverse()) {
        await this.lockService.releaseLock(lock);
      }
    }
  }

  /**
   * Decrements available units across the date range using distributed locking.
   */
  async bookInventoryUnits(
    propertyId: string,
    inventoryUnitCode: string,
    checkInDate: string,
    checkOutDate: string,
    unitsToBook = 1,
  ): Promise<{ success: boolean; totalPriceCents: number; inventoryUnitId: string }> {
    const dates = this.generateDateRange(checkInDate, checkOutDate);

    const unit = await prisma.inventoryUnit.findUnique({
      where: {
        propertyId_externalCode: {
          propertyId,
          externalCode: inventoryUnitCode,
        },
      },
    });

    if (!unit) {
      throw new BadRequestException(`Unit ${inventoryUnitCode} does not exist for property ${propertyId}`);
    }

    return await this.withInventoryLocks(unit.id, dates, async () => {
      return await prisma.$transaction(async (tx) => {
        let totalCalculatedCents = 0;

        for (const date of dates) {
          const row = await tx.inventoryCalendar.findUnique({
            where: {
              inventoryUnitId_date: {
                inventoryUnitId: unit.id,
                date,
              },
            },
          });

          if (!row) {
            throw new BadRequestException(
              `Inventory uninitialized for date ${date.toISOString().slice(0, 10)}`,
            );
          }

          if (row.availableUnits < unitsToBook) {
            throw new BadRequestException(
              `Insufficient inventory on ${date.toISOString().slice(0, 10)}: requested ${unitsToBook}, available ${row.availableUnits}`,
            );
          }

          totalCalculatedCents += row.priceInCents * unitsToBook;

          await tx.inventoryCalendar.update({
            where: { id: row.id },
            data: {
              availableUnits: { decrement: unitsToBook },
              version: { increment: 1 },
            },
          });
        }

        this.logger.log(
          `Allocated ${unitsToBook} unit(s) of ${inventoryUnitCode} from ${checkInDate} to ${checkOutDate}`,
        );

        return {
          success: true,
          totalPriceCents: totalCalculatedCents,
          inventoryUnitId: unit.id,
        };
      });
    });
  }

  /**
   * Restores inventory units when a booking is cancelled, acquiring the same sorted per-date locks.
   */
  async restoreInventoryUnits(
    inventoryUnitId: string,
    checkInDate: string,
    checkOutDate: string,
    unitsToRestore = 1,
  ): Promise<void> {
    const dates = this.generateDateRange(checkInDate, checkOutDate);

    await this.withInventoryLocks(inventoryUnitId, dates, async () => {
      await prisma.$transaction(async (tx) => {
        for (const date of dates) {
          await tx.inventoryCalendar.update({
            where: {
              inventoryUnitId_date: {
                inventoryUnitId,
                date,
              },
            },
            data: {
              availableUnits: { increment: unitsToRestore },
              version: { increment: 1 },
            },
          });
        }
      });

      this.logger.log(
        `Restored ${unitsToRestore} unit(s) for unit ${inventoryUnitId} from ${checkInDate} to ${checkOutDate}`,
      );
    });
  }

  /**
   * Retrieves availability and rates across units for a property within a date window.
   */
  async getAvailability(
    propertyId: string,
    from: string,
    to: string,
    unitCode?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('Query parameters "from" and "to" (format: YYYY-MM-DD) are required');
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || isNaN(Date.parse(from))) {
      throw new BadRequestException(`Invalid "from" date: ${from}. Format must be YYYY-MM-DD`);
    }
    if (!dateRegex.test(to) || isNaN(Date.parse(to))) {
      throw new BadRequestException(`Invalid "to" date: ${to}. Format must be YYYY-MM-DD`);
    }
    if (from > to) {
      throw new BadRequestException('"from" date must be earlier than or equal to "to" date');
    }

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
    });

    if (!property) {
      throw new NotFoundException(`Property with ID "${propertyId}" not found`);
    }

    const startDate = new Date(`${from}T00:00:00.000Z`);
    const endDate = new Date(`${to}T00:00:00.000Z`);

    const units = await prisma.inventoryUnit.findMany({
      where: {
        propertyId,
        ...(unitCode ? { externalCode: unitCode } : {}),
      },
      include: {
        calendar: {
          where: {
            date: {
              gte: startDate,
              lte: endDate,
            },
          },
          orderBy: { date: 'asc' },
        },
      },
      orderBy: { externalCode: 'asc' },
    });

    return {
      propertyId: property.id,
      propertyName: property.name,
      currency: property.currency,
      timezone: property.timezone,
      from,
      to,
      units: units.map((u) => ({
        id: u.id,
        code: u.externalCode,
        name: u.name,
        totalUnits: u.totalUnits,
        calendar: u.calendar.map((c) => ({
          date: c.date.toISOString().slice(0, 10),
          availableUnits: c.availableUnits,
          priceInCents: c.priceInCents,
          isAvailable: c.availableUnits > 0,
        })),
      })),
    };
  }

  /**
   * Bulk updates availability and rates for an inventory unit and triggers outbound fan-out.
   */
  async bulkUpdateCalendar(
    propertyId: string,
    unitCode: string,
    entries: CalendarUpdateEntry[],
  ) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BadRequestException('Calendar entries must be a non-empty array');
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (const entry of entries) {
      if (!entry.date || !dateRegex.test(entry.date) || isNaN(Date.parse(entry.date))) {
        throw new BadRequestException(`Invalid date "${entry?.date}". Format must be YYYY-MM-DD`);
      }
      if (
        entry.availableUnits !== undefined &&
        (typeof entry.availableUnits !== 'number' || entry.availableUnits < 0 || !Number.isInteger(entry.availableUnits))
      ) {
        throw new BadRequestException(
          `availableUnits must be a non-negative integer for date ${entry.date}`,
        );
      }
      if (
        entry.priceInCents !== undefined &&
        (typeof entry.priceInCents !== 'number' || entry.priceInCents < 0 || !Number.isInteger(entry.priceInCents))
      ) {
        throw new BadRequestException(
          `priceInCents must be a non-negative integer for date ${entry.date}`,
        );
      }
    }

    const unit = await prisma.inventoryUnit.findUnique({
      where: {
        propertyId_externalCode: {
          propertyId,
          externalCode: unitCode,
        },
      },
    });

    if (!unit) {
      throw new NotFoundException(`Inventory unit "${unitCode}" not found for property "${propertyId}"`);
    }

    const dates = entries.map((e) => new Date(`${e.date}T00:00:00.000Z`));

    const updatedRows = await this.withInventoryLocks(unit.id, dates, async () => {
      return await prisma.$transaction(async (tx) => {
        const rows = [];
        for (const entry of entries) {
          const date = new Date(`${entry.date}T00:00:00.000Z`);
          const row = await tx.inventoryCalendar.upsert({
            where: {
              inventoryUnitId_date: {
                inventoryUnitId: unit.id,
                date,
              },
            },
            update: {
              ...(entry.availableUnits !== undefined ? { availableUnits: entry.availableUnits } : {}),
              ...(entry.priceInCents !== undefined ? { priceInCents: entry.priceInCents } : {}),
              version: { increment: 1 },
            },
            create: {
              inventoryUnitId: unit.id,
              date,
              availableUnits:
                entry.availableUnits !== undefined ? entry.availableUnits : unit.totalUnits,
              priceInCents: entry.priceInCents !== undefined ? entry.priceInCents : 0,
              version: 0,
            },
          });
          rows.push(row);
        }
        return rows;
      });
    });

    // Trigger availability fan-out across all active partner adaptors
    if (this.syncService) {
      for (const row of updatedRows) {
        const payload: CanonicalInventoryPushPayload = {
          propertyId,
          inventoryUnitCode: unit.externalCode,
          date: row.date.toISOString().slice(0, 10),
          availableUnits: row.availableUnits,
          priceInCents: row.priceInCents,
        };
        await this.syncService.broadcastInventoryUpdate(payload);
      }
      this.logger.log(
        `Dispatched fan-out push for ${updatedRows.length} calendar updates on unit ${unitCode} (Property: ${propertyId})`,
      );
    }

    return {
      success: true,
      propertyId,
      inventoryUnitCode: unit.externalCode,
      updatedCount: updatedRows.length,
      fanoutTriggered: !!this.syncService,
      entries: updatedRows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        availableUnits: r.availableUnits,
        priceInCents: r.priceInCents,
      })),
    };
  }
}