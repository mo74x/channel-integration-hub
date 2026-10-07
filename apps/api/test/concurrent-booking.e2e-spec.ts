import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma } from '@cih/database';
import {
  checkServicesAvailable,
  createTestApp,
  seedE2EFixtures,
  generatePartnerCSignature,
  flushTestRedis,
} from './e2e-helper.js';

describe('Concurrent Booking Race Conditions E2E', () => {
  let app: INestApplication;
  let servicesReady = false;

  beforeAll(async () => {
    servicesReady = await checkServicesAvailable();
    if (!servicesReady) {
      console.warn(
        '⚠️ Skipping Concurrent Booking E2E: PostgreSQL or Redis is not reachable. Run "docker compose up -d" locally.',
      );
      return;
    }

    await flushTestRedis();
    await seedE2EFixtures();
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await prisma.$disconnect();
  });

  it('20 concurrent bookings for the last unit -> exactly one succeeds', async () => {
    if (!servicesReady) return;

    const raceDate = new Date('2026-12-01T00:00:00.000Z');

    // Verify initial single unit availability
    const initialSlot = await prisma.inventoryCalendar.findFirstOrThrow({
      where: { date: raceDate },
    });
    expect(initialSlot.availableUnits).toBe(1);

    const CONCURRENCY = 20;

    // Dispatch 20 concurrent booking attempts for the same single room on 2026-12-01
    const bookingPromises = Array.from({ length: CONCURRENCY }, async (_, index) => {
      const eventId = `evt_race_${index}_${Date.now()}`;
      const bookingRef = `BOOK-RACE-${index}-${Date.now()}`;

      const payload = {
        property_id: 'EXT-PROP-C-303',
        event_meta: {
          event_id: eventId,
        },
        reservation: {
          booking_ref: bookingRef,
          resort_id: 'EXT-PROP-C-303',
          unit_type: 'DELUXE_KING',
          lifecycle_state: 'CONFIRMED',
          stay: {
            arrival: '2026-12-01',
            departure: '2026-12-02',
            quantity: 1,
          },
          guest: {
            name: `Contender ${index}`,
            contact: `contender_${index}@example.com`,
          },
          pricing: {
            charged_amount_cents: 25000,
            currency: 'USD',
          },
        },
      };

      const payloadStr = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = generatePartnerCSignature(payloadStr, timestamp);

      return request(app.getHttpServer())
        .post('/webhooks/partner_c')
        .set('Content-Type', 'application/json')
        .set('x-starlight-signature', signature)
        .set('x-starlight-timestamp', timestamp)
        .set('x-starlight-event-id', eventId)
        .send(payloadStr);
    });

    const results = await Promise.all(bookingPromises);

    // Assert exactly 1 request succeeded
    const successfulResponses = results.filter((r) => r.status === 200);
    const failedResponses = results.filter((r) => r.status !== 200);

    expect(successfulResponses).toHaveLength(1);
    expect(successfulResponses[0].body).toMatchObject({
      acknowledged: true,
      status: 'CONFIRMED',
    });

    // The other 19 must have failed (either 400 Insufficient Inventory or 409 Lock Contention)
    expect(failedResponses).toHaveLength(CONCURRENCY - 1);
    for (const failed of failedResponses) {
      expect([400, 409, 422]).toContain(failed.status);
    }

    // Database verification:
    // 1. Available units must be exactly 0 (no overselling, never negative)
    const finalSlot = await prisma.inventoryCalendar.findFirstOrThrow({
      where: { date: raceDate },
    });
    expect(finalSlot.availableUnits).toBe(0);

    // 2. Exactly one reservation was persisted in the database for that date
    const totalConfirmedReservations = await prisma.reservation.count({
      where: {
        checkInDate: raceDate,
        status: 'CONFIRMED',
      },
    });
    expect(totalConfirmedReservations).toBe(1);
  });
});
