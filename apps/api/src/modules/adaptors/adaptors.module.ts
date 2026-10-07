import { Module } from '@nestjs/common';
import { PartnerAAdaptor } from './drivers/partner-a.adaptor.js';
import { PartnerBAdaptor } from './drivers/partner-b.adaptor.js';
import { PartnerCAdaptor } from './drivers/partner-c.adaptor.js';
import { PartnerDAdaptor } from './drivers/partner-d.adaptor.js';
import { PartnerAdaptor } from './partner-adaptor.interface.js';

@Module({
  providers: [
    PartnerAAdaptor,
    PartnerBAdaptor,
    PartnerCAdaptor,
    PartnerDAdaptor,
    {
      provide: 'ADAPTOR_REGISTRY',
      useFactory: (
        a: PartnerAAdaptor,
        b: PartnerBAdaptor,
        c: PartnerCAdaptor,
        d: PartnerDAdaptor,
      ) => {
        const registry = new Map<string, PartnerAdaptor>();
        registry.set(a.partnerSlug, a);
        registry.set(b.partnerSlug, b);
        registry.set(c.partnerSlug, c);
        registry.set(d.partnerSlug, d);
        return registry;
      },
      inject: [PartnerAAdaptor, PartnerBAdaptor, PartnerCAdaptor, PartnerDAdaptor],
    },
  ],
  exports: ['ADAPTOR_REGISTRY', PartnerAAdaptor, PartnerBAdaptor, PartnerCAdaptor, PartnerDAdaptor],
})
export class AdaptorsModule {}
