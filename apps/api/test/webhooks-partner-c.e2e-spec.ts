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

describe('Partner C Webhooks & Idempotency E2E', () => {
  let app: INestApplication;
  let servicesReady = false;

  beforeAll(async () => {
    servicesReady = await checkServicesAvailable();
    if (!servicesReady) {
      console.warn(
        '⚠️ Skipping Partner C Webhook E2E: PostgreSQL or Redis is not reachable. Run "docker compose up -d" locally.',
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

  it('processes Partner C signed webhook -> creates reservation, decrements inventory, and enqueues fan-out jobs', async () => {
    if (!servicesReady) return;

    const eventId = 'evt_e2e_booking_001';
    const bookingRef = 'BOOK-C-E2E-001';
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
          arrival: '2026-11-10',
          departure: '2026-11-12',
          quantity: 1,
        },
        guest: {
          name: 'Eleanor Vance',
          contact: 'eleanor.vance@hillhouse.org',
        },
        pricing: {
          charged_amount_cents: 50000,
          currency: 'USD',
        },
      },
    };

    const payloadStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = generatePartnerCSignature(payloadStr, timestamp);

    // 1. Dispatch Webhook request
    const response = await request(app.getHttpServer())
      .post('/webhooks/partner_c')
      .set('Content-Type', 'application/json')
      .set('x-starlight-signature', signature)
      .set('x-starlight-timestamp', timestamp)
      .set('x-starlight-event-id', eventId)
      .send(payloadStr);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      acknowledged: true,
      status: 'CONFIRMED',
    });
    expect(response.body.reservationId).toBeDefined();

    // 2. Database assertion: Reservation created
    const reservation = await prisma.reservation.findFirst({
      where: { externalBookingId: bookingRef },
      include: { partner: true, inventoryUnit: true },
    });

    expect(reservation).not.toBeNull();
    expect(reservation?.status).toBe('CONFIRMED');
    expect(reservation?.partner.slug).toBe('partner_c');
    expect(reservation?.inventoryUnit.externalCode).toBe('DELUXE_KING');
    expect(reservation?.unitsBooked).toBe(1);

    // 3. Database assertion: Inventory decremented
    // Stay is 2026-11-10 to 2026-11-12 (2 nights: 11-10, 11-11). Initial availableUnits was 5.
    const updatedCalendar = await prisma.inventoryCalendar.findMany({
      where: {
        inventoryUnitId: reservation!.inventoryUnitId,
        date: {
          in: [new Date('2026-11-10T00:00:00.000Z'), new Date('2026-11-11T00:00:00.000Z')],
        },
      },
      orderBy: { date: 'asc' },
    });

    expect(updatedCalendar).toHaveLength(2);
    expect(updatedCalendar[0].availableUnits).toBe(4);
    expect(updatedCalendar[1].availableUnits).toBe(4);

    // 4. Database assertion: Fan-out sync jobs enqueued for other active partners (partner_a, partner_b)
    const fanoutJobs = await prisma.syncJob.findMany({
      where: {
        jobType: 'OUTBOUND_PUSH',
        entityType: 'INVENTORY_CALENDAR',
      },
      include: { partner: true },
    });

    expect(fanoutJobs.length).toBeGreaterThanOrEqual(2);
    // Crucial: Originating partner (partner_c) must NOT receive the fan-out to prevent echo loop
    const partnerSlugsReceivingPush = fanoutJobs.map((j) => j.partner.slug);
    expect(partnerSlugsReceivingPush).toContain('partner_a');
    expect(partnerSlugsReceivingPush).toContain('partner_b');
    expect(partnerSlugsReceivingPush).not.toContain('partner_c');
  });

  it('replays the cached response when a duplicate webhook is received', async () => {
    if (!servicesReady) return;

    const eventId = 'evt_e2e_booking_002';
    const bookingRef = 'BOOK-C-E2E-002';
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
          arrival: '2026-11-13',
          departure: '2026-11-14',
          quantity: 1,
        },
        guest: {
          name: 'Theodora Crain',
          contact: 'theo.crain@hillhouse.org',
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

    // Initial dispatch
    const firstResponse = await request(app.getHttpServer())
      .post('/webhooks/partner_c')
      .set('Content-Type', 'application/json')
      .set('x-starlight-signature', signature)
      .set('x-starlight-timestamp', timestamp)
      .set('x-starlight-event-id', eventId)
      .send(payloadStr);

    expect(firstResponse.status).toBe(200);
    const originalReservationId = firstResponse.body.reservationId;
    expect(originalReservationId).toBeDefined();

    // Check calendar inventory after first call
    const initialCalendar = await prisma.inventoryCalendar.findFirstOrThrow({
      where: {
        date: new Date('2026-11-13T00:00:00.000Z'),
      },
    });
    expect(initialCalendar.availableUnits).toBe(4); // 5 - 1

    // Second dispatch with identical payload and event ID (duplicate webhook)
    const duplicateResponse = await request(app.getHttpServer())
      .post('/webhooks/partner_c')
      .set('Content-Type', 'application/json')
      .set('x-starlight-signature', signature)
      .set('x-starlight-timestamp', timestamp)
      .set('x-starlight-event-id', eventId)
      .send(payloadStr);

    expect(duplicateResponse.status).toBe(200);
    // Cached response replayed directly
    expect(duplicateResponse.body.reservationId).toBe(originalReservationId);
    expect(duplicateResponse.body.acknowledged).toBe(true);

    // Database assertions: Reservation not duplicated, inventory not decremented again
    const reservationCount = await prisma.reservation.count({
      where: { externalBookingId: bookingRef },
    });
    expect(reservationCount).toBe(1);

    const postDuplicateCalendar = await prisma.inventoryCalendar.findFirstOrThrow({
      where: {
        date: new Date('2026-11-13T00:00:00.000Z'),
      },
    });
    expect(postDuplicateCalendar.availableUnits).toBe(4); // Remains 4, NOT 3
  });
});
