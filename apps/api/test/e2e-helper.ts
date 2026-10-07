import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import Redis from 'ioredis';
import { prisma, PartnerAuthType, PartnerStatus } from '@cih/database';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

export interface SeededData {
  partnerA: any;
  partnerB: any;
  partnerC: any;
  property: any;
  unit: any;
}

/**
 * Checks whether PostgreSQL and Redis services are reachable.
 */
export async function checkServicesAvailable(): Promise<boolean> {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = Number(process.env.REDIS_PORT) || 6379;
  const redisPassword = process.env.REDIS_PASSWORD || 'redis_secure_password';

  try {
    // 1. Verify PostgreSQL connectivity
    await prisma.$queryRaw`SELECT 1`;

    // 2. Verify Redis connectivity
    const redis = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    await redis.connect();
    await redis.ping();
    await redis.quit();

    return true;
  } catch (error) {
    if (process.env.CI) {
      console.error('❌ Service connectivity failed in CI environment:', error);
      throw error;
    }
    return false;
  }
}

/**
 * Bootstraps a fresh NestJS application instance configured with rawBody for HMAC verification.
 */
export async function createTestApp(): Promise<{ app: INestApplication; module: TestingModule }> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.init();
  return { app, module: moduleFixture };
}

/**
 * Resets database and seeds baseline fixtures for E2E tests.
 */
export async function seedE2EFixtures(): Promise<SeededData> {
  // 1. Clean up transactional records
  await prisma.reconciliationLog.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.inventoryCalendar.deleteMany();
  await prisma.propertyPartnerMapping.deleteMany();
  await prisma.inventoryUnit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.partner.deleteMany();

  // 2. Create Partners
  const partnerA = await prisma.partner.create({
    data: {
      slug: 'partner_a',
      name: 'OmniBooking Global (Partner A)',
      authType: PartnerAuthType.API_KEY,
      status: PartnerStatus.ACTIVE,
      apiKey: process.env.PARTNER_A_API_KEY || 'cih_live_partner_a_key_98765',
    },
  });

  const partnerB = await prisma.partner.create({
    data: {
      slug: 'partner_b',
      name: 'Zenith PMS Services (Partner B)',
      authType: PartnerAuthType.OAUTH2,
      status: PartnerStatus.ACTIVE,
    },
  });

  const partnerC = await prisma.partner.create({
    data: {
      slug: 'partner_c',
      name: 'Starlight Resorts Engine (Partner C)',
      authType: PartnerAuthType.HMAC_SIGNATURE,
      status: PartnerStatus.ACTIVE,
      webhookSecret: process.env.PARTNER_C_HMAC_SECRET || 'c8f126f5e92be2b1a8f940821d3e86f8',
    },
  });

  // 3. Create Canonical Property
  const property = await prisma.property.create({
    data: {
      id: 'e2e-prop-grand-azure',
      name: 'The Grand Azure Hotel',
      timezone: 'UTC',
      currency: 'USD',
    },
  });

  // 4. Partner Mappings
  await prisma.propertyPartnerMapping.createMany({
    data: [
      { propertyId: property.id, partnerId: partnerA.id, externalPropertyId: 'EXT-PROP-A-101' },
      { propertyId: property.id, partnerId: partnerB.id, externalPropertyId: 'EXT-PROP-B-202' },
      { propertyId: property.id, partnerId: partnerC.id, externalPropertyId: 'EXT-PROP-C-303' },
    ],
  });

  // 5. Inventory Unit
  const unit = await prisma.inventoryUnit.create({
    data: {
      id: 'e2e-unit-deluxe-king',
      propertyId: property.id,
      externalCode: 'DELUXE_KING',
      name: 'Deluxe King Suite',
      totalUnits: 5,
    },
  });

  // 6. Availability Calendar for Stay Dates (2026-11-10 to 2026-11-15, 5 units available)
  const stayDates = [
    new Date('2026-11-10T00:00:00.000Z'),
    new Date('2026-11-11T00:00:00.000Z'),
    new Date('2026-11-12T00:00:00.000Z'),
    new Date('2026-11-13T00:00:00.000Z'),
    new Date('2026-11-14T00:00:00.000Z'),
    new Date('2026-11-15T00:00:00.000Z'),
  ];

  await prisma.inventoryCalendar.createMany({
    data: stayDates.map((date) => ({
      inventoryUnitId: unit.id,
      date,
      availableUnits: 5,
      priceInCents: 25000,
      version: 0,
    })),
  });

  // 7. Single-slot availability for 20 concurrent booking race condition (2026-12-01, exactly 1 unit available)
  await prisma.inventoryCalendar.create({
    data: {
      inventoryUnitId: unit.id,
      date: new Date('2026-12-01T00:00:00.000Z'),
      availableUnits: 1, // Only 1 unit physical capacity remaining!
      priceInCents: 25000,
      version: 0,
    },
  });

  return { partnerA, partnerB, partnerC, property, unit };
}

/**
 * Computes Partner C HMAC-SHA256 signature for a given payload and timestamp.
 */
export function generatePartnerCSignature(
  payload: object | string,
  timestamp: string,
  secret: string = process.env.PARTNER_C_HMAC_SECRET || 'c8f126f5e92be2b1a8f940821d3e86f8',
): string {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHmac('sha256', secret).update(`${timestamp}.${payloadStr}`).digest('hex');
}

/**
 * Flushes Redis database to isolate state between runs.
 */
export async function flushTestRedis(): Promise<void> {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = Number(process.env.REDIS_PORT) || 6379;
  const redisPassword = process.env.REDIS_PASSWORD || 'redis_secure_password';

  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    await redis.flushall();
    await redis.quit();
  } catch {
    // If Redis is unreachable, ignore flush error
  }
}
