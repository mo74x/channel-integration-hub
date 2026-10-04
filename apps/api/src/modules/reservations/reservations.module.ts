import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ReservationStateMachineService } from './reservation-state-machine.service.js';

@Module({
  imports: [InventoryModule],
  providers: [ReservationStateMachineService],
  exports: [ReservationStateMachineService],
})
export class ReservationsModule {}