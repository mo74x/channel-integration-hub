import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { prisma } from '@cih/database';
import { ReservationStatus } from '@cih/shared';

export interface FindReservationsQuery {
  partner?: string;
  partnerId?: string;
  partnerSlug?: string;
  status?: ReservationStatus;
  from?: string;
  to?: string;
  startDate?: string;
  endDate?: string;
  checkInFrom?: string;
  checkInTo?: string;
  propertyId?: string;
  page?: string | number;
  limit?: string | number;
  skip?: string | number;
  take?: string | number;
}

@Injectable()
export class ReservationsService {

  /**
   * Retrieves paginated reservations matching partner, status, and date range filters.
   */
  async findReservations(query: FindReservationsQuery) {
    const where: any = {};

    // 1. Filter by Partner (by internal UUID or slug)
    const partnerFilter = query.partner || query.partnerId || query.partnerSlug;
    if (partnerFilter) {
      where.OR = [
        { partnerId: partnerFilter },
        { partner: { slug: partnerFilter } },
      ];
    }

    // 2. Filter by Status
    if (query.status) {
      const validStatuses = Object.values(ReservationStatus);
      if (!validStatuses.includes(query.status)) {
        throw new BadRequestException(
          `Invalid status "${query.status}". Allowed values: ${validStatuses.join(', ')}`,
        );
      }
      where.status = query.status;
    }

    // 3. Filter by Property
    if (query.propertyId) {
      where.propertyId = query.propertyId;
    }

    // 4. Filter by Date range (stay check-in date)
    const from = query.from || query.startDate || query.checkInFrom;
    const to = query.to || query.endDate || query.checkInTo;

    if (from || to) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (from && (!dateRegex.test(from) || isNaN(Date.parse(from)))) {
        throw new BadRequestException(`Invalid date "${from}". Format must be YYYY-MM-DD`);
      }
      if (to && (!dateRegex.test(to) || isNaN(Date.parse(to)))) {
        throw new BadRequestException(`Invalid date "${to}". Format must be YYYY-MM-DD`);
      }
      if (from && to && from > to) {
        throw new BadRequestException('"from" date must be earlier than or equal to "to" date');
      }

      where.checkInDate = {
        ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
        ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
      };
    }

    // 5. Pagination
    const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(query.limit || query.take || '20'), 10) || 20),
    );
    const skip =
      query.skip !== undefined
        ? Math.max(0, parseInt(String(query.skip), 10) || 0)
        : (page - 1) * limit;

    const [total, reservations] = await Promise.all([
      prisma.reservation.count({ where }),
      prisma.reservation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          partner: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
          inventoryUnit: {
            select: {
              id: true,
              externalCode: true,
              name: true,
              totalUnits: true,
            },
          },
          property: {
            select: {
              id: true,
              name: true,
              currency: true,
              timezone: true,
            },
          },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: reservations,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Fetches a single reservation by ID (or fallback external booking ID).
   */
  async getReservationById(id: string) {
    if (!id) {
      throw new BadRequestException('Reservation ID is required');
    }

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        partner: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        inventoryUnit: {
          select: {
            id: true,
            externalCode: true,
            name: true,
            totalUnits: true,
          },
        },
        property: {
          select: {
            id: true,
            name: true,
            currency: true,
            timezone: true,
          },
        },
      },
    });

    if (!reservation) {
      // Fallback search by external booking ref
      const byExternal = await prisma.reservation.findFirst({
        where: { externalBookingId: id },
        include: {
          partner: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
          inventoryUnit: {
            select: {
              id: true,
              externalCode: true,
              name: true,
              totalUnits: true,
            },
          },
          property: {
            select: {
              id: true,
              name: true,
              currency: true,
              timezone: true,
            },
          },
        },
      });

      if (byExternal) {
        return byExternal;
      }

      throw new NotFoundException(`Reservation with ID "${id}" not found`);
    }

    return reservation;
  }
}
