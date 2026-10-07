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
import { InventoryService } from './inventory.service.js';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get(':propertyId/availability')
  async getAvailability(
    @Param('propertyId') propertyId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('unitCode') unitCode?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException(
        'Query parameters "from" and "to" (format: YYYY-MM-DD) are required',
      );
    }
    return this.inventoryService.getAvailability(propertyId, from, to, unitCode);
  }

  @Put(':propertyId/units/:code/calendar')
  @HttpCode(HttpStatus.OK)
  async bulkUpdateCalendar(
    @Param('propertyId') propertyId: string,
    @Param('code') code: string,
    @Body() body: any,
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
