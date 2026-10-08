import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CalendarEntryDto {
  @ApiProperty({
    description: 'Date for the inventory availability entry (YYYY-MM-DD)',
    example: '2026-12-01',
  })
  date!: string;

  @ApiProperty({
    description: 'Number of available units for this date',
    example: 5,
    minimum: 0,
  })
  availableUnits!: number;

  @ApiProperty({
    description: 'Nightly price in smallest currency unit (e.g. cents)',
    example: 15000,
    minimum: 0,
  })
  priceInCents!: number;
}

export class BulkUpdateCalendarDto {
  @ApiPropertyOptional({
    description: 'List of calendar slot updates',
    type: [CalendarEntryDto],
  })
  entries?: CalendarEntryDto[];
}

export class GetAvailabilityQueryDto {
  @ApiProperty({
    description: 'Start date for availability query (YYYY-MM-DD)',
    example: '2026-12-01',
  })
  from!: string;

  @ApiProperty({
    description: 'End date for availability query (YYYY-MM-DD)',
    example: '2026-12-07',
  })
  to!: string;

  @ApiPropertyOptional({
    description: 'Optional filter by inventory unit code (e.g. DELUXE_KING)',
    example: 'DELUXE_KING',
  })
  unitCode?: string;
}
