import { Module } from '@nestjs/common';
import { PartnerAController } from './partner-a/partner-a.controller.js';
import { PartnerBController } from './partner-b/partner-b.controller.js';
import { PartnerCController } from './partner-c/partner-c.controller.js';

@Module({
  controllers: [PartnerAController, PartnerBController, PartnerCController],
})
export class AppModule {}