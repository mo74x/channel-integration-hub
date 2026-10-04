import { Module } from '@nestjs/common';
import { PartnerAAdaptor } from './drivers/partner-a.adaptor.js';
import { PartnerBAdaptor } from './drivers/partner-b.adaptor.js';
import { PartnerCAdaptor } from './drivers/partner-c.adaptor.js';
import { PartnerAdaptor } from './partner-adaptor.interface.js';

@Module({
  providers: [
    PartnerAAdaptor,
    PartnerBAdaptor,
    PartnerCAdaptor,
    {
      provide: 'ADAPTOR_REGISTRY',
      useFactory: (a: PartnerAAdaptor, b: PartnerBAdaptor, c: PartnerCAdaptor) => {
        const registry = new Map<string, PartnerAdaptor>();
        registry.set(a.partnerSlug, a);
        registry.set(b.partnerSlug, b);
        registry.set(c.partnerSlug, c);
        return registry;
      },
      inject: [PartnerAAdaptor, PartnerBAdaptor, PartnerCAdaptor],
    },
  ],
  exports: ['ADAPTOR_REGISTRY', PartnerAAdaptor, PartnerBAdaptor, PartnerCAdaptor],
})
export class AdaptorsModule {}