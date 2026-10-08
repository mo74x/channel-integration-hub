import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationStatus } from '@cih/shared';

export class FindReservationsDto {
  @ApiPropertyOptional({
    description: 'Filter by partner slug or internal UUID',
    example: 'partner_a',
  })
  partner?: string;

  @ApiPropertyOptional({
    description: 'Internal partner UUID',
  })
  partnerId?: string;

  @ApiPropertyOptional({
    description: 'Partner slug (e.g. partner_a, partner_b)',
  })
  partnerSlug?: string;

  @ApiPropertyOptional({
    description: 'Filter by reservation status',
    enum: ReservationStatus,
    example: ReservationStatus.CONFIRMED,
  })
  status?: ReservationStatus;

  @ApiPropertyOptional({
    description: 'Check-in lower bound date (YYYY-MM-DD)',
    example: '2026-12-01',
  })
  from?: string;

  @ApiPropertyOptional({
    description: 'Check-in upper bound date (YYYY-MM-DD)',
    example: '2026-12-31',
  })
  to?: string;

  @ApiPropertyOptional({
    description: 'Alias for from date (YYYY-MM-DD)',
  })
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Alias for to date (YYYY-MM-DD)',
  })
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Alias for from date (YYYY-MM-DD)',
  })
  checkInFrom?: string;

  @ApiPropertyOptional({
    description: 'Alias for to date (YYYY-MM-DD)',
  })
  checkInTo?: string;

  @ApiPropertyOptional({
    description: 'Filter by property UUID',
  })
  propertyId?: string;

  @ApiPropertyOptional({
    description: 'Pagination page number (default 1)',
    example: 1,
  })
  page?: string | number;

  @ApiPropertyOptional({
    description: 'Pagination limit (default 20, max 100)',
    example: 20,
  })
  limit?: string | number;

  @ApiPropertyOptional({
    description: 'Pagination skip offset',
  })
  skip?: string | number;

  @ApiPropertyOptional({
    description: 'Pagination take count',
  })
  take?: string | number;
}
