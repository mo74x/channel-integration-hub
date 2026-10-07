import { Module, forwardRef } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { InventoryController } from './inventory.controller.js';
import { SyncModule } from '../sync/sync.module.js';

@Module({
  imports: [forwardRef(() => SyncModule)],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}