import { Module, forwardRef } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  ReservationStateMachineService,
  domainEventEmitter,
} from './reservation-state-machine.service.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationsController } from './reservations.controller.js';

@Module({
  imports: [forwardRef(() => InventoryModule)],
  controllers: [ReservationsController],
  providers: [
    ReservationStateMachineService,
    ReservationsService,
    {
      provide: 'DOMAIN_EVENT_EMITTER',
      useValue: domainEventEmitter,
    },
  ],
  exports: [ReservationStateMachineService, ReservationsService, 'DOMAIN_EVENT_EMITTER'],
})
export class ReservationsModule {}
