import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  ReservationStateMachineService,
  domainEventEmitter,
} from './reservation-state-machine.service.js';

@Module({
  imports: [InventoryModule],
  providers: [
    ReservationStateMachineService,
    {
      provide: 'DOMAIN_EVENT_EMITTER',
      useValue: domainEventEmitter,
    },
  ],
  exports: [ReservationStateMachineService, 'DOMAIN_EVENT_EMITTER'],
})
export class ReservationsModule {}