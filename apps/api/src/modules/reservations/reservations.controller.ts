import { Controller, Get, Param, Query } from '@nestjs/common';
import { ReservationsService, FindReservationsQuery } from './reservations.service.js';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  async getReservations(@Query() query: FindReservationsQuery) {
    return this.reservationsService.findReservations(query);
  }

  @Get(':id')
  async getReservationById(@Param('id') id: string) {
    return this.reservationsService.getReservationById(id);
  }
}
