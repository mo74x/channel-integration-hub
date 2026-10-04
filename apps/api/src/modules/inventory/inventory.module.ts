import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';

@Module({
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}