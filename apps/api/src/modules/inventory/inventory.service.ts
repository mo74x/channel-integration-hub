import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { prisma } from '@cih/database';
import { DistributedLockService } from '../../common/redis/distributed-lock.service.js';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly lockService: DistributedLockService) {}

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
}