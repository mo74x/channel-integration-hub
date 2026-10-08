import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiBody,
} from '@nestjs/swagger';
import { InventoryService } from './inventory.service.js';

import {
  CalendarEntryDto,
  BulkUpdateCalendarDto,
  GetAvailabilityQueryDto,
} from './dto/calendar.dto.js';

@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get(':propertyId/availability')
  @ApiOperation({
    summary: 'Query availability calendar',
    description: 'Returns availability and pricing for all inventory units (or a specific unit) of a property within a date range.',
  })
  @ApiParam({ name: 'propertyId', description: 'Property UUID', format: 'uuid' })
  @ApiOkResponse({ description: 'Availability calendar with per-unit, per-date breakdown.' })
  @ApiBadRequestResponse({ description: 'Missing or invalid date parameters.' })
  @ApiNotFoundResponse({ description: 'Property not found.' })
  async getAvailability(
    @Param('propertyId') propertyId: string,
    @Query('from') fromOrQuery: string | GetAvailabilityQueryDto,
    @Query('to') maybeTo?: string,
    @Query('unitCode') maybeUnitCode?: string,
  ) {
    let from: string | undefined;
    let to: string | undefined;
    let unitCode: string | undefined;

    if (typeof fromOrQuery === 'object' && fromOrQuery !== null) {
      from = fromOrQuery.from;
      to = fromOrQuery.to;
      unitCode = fromOrQuery.unitCode;
    } else {
      from = fromOrQuery;
      to = maybeTo;
      unitCode = maybeUnitCode;
    }

    if (!from || !to) {
      throw new BadRequestException(
        'Query parameters "from" and "to" (format: YYYY-MM-DD) are required',
      );
    }
    return this.inventoryService.getAvailability(propertyId, from, to, unitCode);
  }

  @Put(':propertyId/units/:code/calendar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-update calendar slots',
    description: 'Upserts availability and pricing for an inventory unit across multiple dates. Triggers outbound fan-out to all active partners.',
  })
  @ApiParam({ name: 'propertyId', description: 'Property UUID', format: 'uuid' })
  @ApiParam({ name: 'code', description: 'Inventory unit external code (e.g. DELUXE_KING)', example: 'DELUXE_KING' })
  @ApiBody({
    description: 'Array of calendar entries or object containing entries array.',
    type: BulkUpdateCalendarDto,
    examples: {
      arrayExample: {
        summary: 'Direct array of entries',
        value: [
          { date: '2026-12-01', availableUnits: 5, priceInCents: 15000 },
          { date: '2026-12-02', availableUnits: 4, priceInCents: 16000 },
        ],
      },
      objectExample: {
        summary: 'Object with entries property',
        value: {
          entries: [
            { date: '2026-12-01', availableUnits: 5, priceInCents: 15000 },
            { date: '2026-12-02', availableUnits: 4, priceInCents: 16000 },
          ],
        },
      },
    },
  })
  @ApiOkResponse({ description: 'Calendar updated; fan-out dispatched to active partners.' })
  @ApiBadRequestResponse({ description: 'Invalid entry format or empty array.' })
  @ApiNotFoundResponse({ description: 'Inventory unit not found.' })
  async bulkUpdateCalendar(
    @Param('propertyId') propertyId: string,
    @Param('code') code: string,
    @Body() body: CalendarEntryDto[] | BulkUpdateCalendarDto | any,
  ) {
    const entries = Array.isArray(body) ? body : body?.entries || body?.calendar || body?.updates;

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BadRequestException(
        'Request body must be a non-empty array of calendar updates or contain an "entries" array',
      );
    }

    return this.inventoryService.bulkUpdateCalendar(propertyId, code, entries);
  }
}

