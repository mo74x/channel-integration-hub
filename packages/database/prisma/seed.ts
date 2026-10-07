import { PrismaClient, PartnerAuthType, PartnerStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  console.log('Seeding Channel Integration Hub database...');

  // 1. Cleanup existing records
  await prisma.reconciliationLog.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.inventoryCalendar.deleteMany();
  await prisma.propertyPartnerMapping.deleteMany();
  await prisma.inventoryUnit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.partner.deleteMany();

  // 2. Seed Partners
  const partnerA = await prisma.partner.create({
    data: {
      slug: 'partner_a',
      name: 'OmniBooking Global (Partner A)',
      authType: PartnerAuthType.API_KEY,
      status: PartnerStatus.ACTIVE,
      apiKey: process.env.PARTNER_A_API_KEY || 'cih_live_partner_a_key_98765',
      rateLimitConfig: { maxRps: 20, burst: 40 },
    },
  });

  const partnerB = await prisma.partner.create({
    data: {
      slug: 'partner_b',
      name: 'Zenith PMS Services (Partner B)',
      authType: PartnerAuthType.OAUTH2,
      status: PartnerStatus.ACTIVE,
      oauthConfig: {
        tokenUrl: 'http://localhost:4000/partner-b/oauth/token',
        clientId: process.env.PARTNER_B_CLIENT_ID || 'client_b_channel_corp',
        clientSecret: process.env.PARTNER_B_CLIENT_SECRET || 'secret_b_oauth_token_val',
      },
      rateLimitConfig: { maxRps: 5, burst: 10 },
    },
  });

  const partnerC = await prisma.partner.create({
    data: {
      slug: 'partner_c',
      name: 'Starlight Resorts Engine (Partner C)',
      authType: PartnerAuthType.HMAC_SIGNATURE,
      status: PartnerStatus.ACTIVE,
      webhookSecret: process.env.PARTNER_C_HMAC_SECRET || 'c8f126f5e92be2b1a8f940821d3e86f8',
      rateLimitConfig: { maxRps: 50, burst: 100 },
    },
  });

  const partnerD = await prisma.partner.create({
    data: {
      slug: 'partner_d',
      name: 'Vanguard Suites Hub (Partner D)',
      authType: PartnerAuthType.API_KEY,
      status: PartnerStatus.ACTIVE,
      apiKey: process.env.PARTNER_D_API_KEY || 'cih_live_partner_d_key_112233',
      rateLimitConfig: { maxRps: 25, burst: 50 },
    },
  });

  // 3. Seed Canonical Property
  const property = await prisma.property.create({
    data: {
      id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      name: 'The Grand Azure Hotel',
      timezone: 'UTC',
      currency: 'USD',
    },
  });

  // 4. Map Property across Partners
  await prisma.propertyPartnerMapping.createMany({
    data: [
      { propertyId: property.id, partnerId: partnerA.id, externalPropertyId: 'EXT-PROP-A-101' },
      { propertyId: property.id, partnerId: partnerB.id, externalPropertyId: 'EXT-PROP-B-202' },
      { propertyId: property.id, partnerId: partnerC.id, externalPropertyId: 'EXT-PROP-C-303' },
      { propertyId: property.id, partnerId: partnerD.id, externalPropertyId: 'EXT-PROP-D-404' },
    ],
  });

  // 5. Seed Inventory Units
  const deluxeKing = await prisma.inventoryUnit.create({
    data: {
      propertyId: property.id,
      externalCode: 'DELUXE_KING',
      name: 'Deluxe King Suite',
      totalUnits: 5,
    },
  });

  const standardQueen = await prisma.inventoryUnit.create({
    data: {
      propertyId: property.id,
      externalCode: 'STANDARD_QUEEN',
      name: 'Standard Queen Room',
      totalUnits: 10,
    },
  });

  // 6. Generate 30 days of calendar inventory availability
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const calendarInserts = [];

  for (let i = 0; i < 30; i++) {
    const calendarDate = new Date(today);
    calendarDate.setUTCDate(today.getUTCDate() + i);

    calendarInserts.push({
      inventoryUnitId: deluxeKing.id,
      date: calendarDate,
      availableUnits: 5,
      priceInCents: 25000, // $250.00
      version: 0,
    });

    calendarInserts.push({
      inventoryUnitId: standardQueen.id,
      date: calendarDate,
      availableUnits: 10,
      priceInCents: 15000, // $150.00
      version: 0,
    });
  }

  await prisma.inventoryCalendar.createMany({
    data: calendarInserts,
  });

  console.log('Seed completed successfully:');
  console.log(
    `- 4 Partners created: ${partnerA.slug}, ${partnerB.slug}, ${partnerC.slug}, ${partnerD.slug}`,
  );
  console.log(`- Property: "${property.name}" (${property.id})`);
  console.log(`- 2 Unit Types initialized with 30-day calendar availability windows.`);
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
