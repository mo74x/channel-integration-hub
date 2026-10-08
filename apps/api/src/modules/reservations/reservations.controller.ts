import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { ReservationsService } from './reservations.service.js';
import { FindReservationsDto } from './dto/find-reservations.dto.js';

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List reservations',
    description: 'Returns paginated reservations with optional filters for partner, status, date range and property.',
  })
  @ApiOkResponse({ description: 'Paginated list of reservations.' })
  @ApiBadRequestResponse({ description: 'Invalid filter parameters.' })
  async getReservations(@Query() query: FindReservationsDto) {
    return this.reservationsService.findReservations(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get reservation by ID',
    description: 'Fetches a single reservation by internal UUID or external booking reference.',
  })
  @ApiParam({ name: 'id', description: 'Internal reservation UUID or external booking ID' })
  @ApiOkResponse({ description: 'Reservation detail with partner, property and inventory unit info.' })
  @ApiNotFoundResponse({ description: 'Reservation not found.' })
  async getReservationById(@Param('id') id: string) {
    return this.reservationsService.getReservationById(id);
  }
}

