import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma } from '@cih/database';
import {
  checkServicesAvailable,
  createTestApp,
  seedE2EFixtures,
  flushTestRedis,
} from './e2e-helper.js';

describe('Admin Endpoints Authentication E2E', () => {
  let app: INestApplication;
  let servicesReady = false;
  const adminApiKey = process.env.ADMIN_API_KEY || 'cih_admin_secret_key_dev';

  beforeAll(async () => {
    servicesReady = await checkServicesAvailable();
    if (!servicesReady) {
      console.warn(
        '⚠️ Skipping Admin API E2E: PostgreSQL or Redis is not reachable. Run "docker compose up -d" locally.',
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

  describe('Unauthenticated requests are rejected with 401', () => {
    it('GET /admin/sync-jobs returns 401 without API key', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer()).get('/admin/sync-jobs');
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or missing Admin API Key/i);
    });

    it('GET /admin/sync-jobs returns 401 with an invalid API key', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer())
        .get('/admin/sync-jobs')
        .set('x-api-key', 'wrong_super_secret_key');

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or missing Admin API Key/i);
    });

    it('POST /admin/sync-jobs/:id/replay returns 401 without API key', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer()).post('/admin/sync-jobs/some-uuid/replay');
      expect(res.status).toBe(401);
    });

    it('POST /admin/partners/:slug/circuit/reset returns 401 without API key', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer()).post(
        '/admin/partners/partner_a/circuit/reset',
      );
      expect(res.status).toBe(401);
    });

    it('PATCH /admin/partners/:slug returns 401 without API key', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer())
        .patch('/admin/partners/partner_a')
        .send({ status: 'DISABLED' });
      expect(res.status).toBe(401);
    });

    it('POST /admin/reconciliation-logs/:id/resolve returns 401 without API key', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer())
        .post('/admin/reconciliation-logs/nonexistent-log/resolve')
        .send({ action: 'DISMISS' });
      expect(res.status).toBe(401);
    });
  });

  describe('Authorized requests with valid API key succeed', () => {
    it('GET /admin/sync-jobs succeeds with x-api-key header', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer())
        .get('/admin/sync-jobs')
        .set('x-api-key', adminApiKey);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it('POST /admin/partners/:slug/circuit/reset succeeds with x-admin-api-key header', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer())
        .post('/admin/partners/partner_a/circuit/reset')
        .set('x-admin-api-key', adminApiKey);

      expect(res.status).toBe(200);
      expect(res.body.acknowledged).toBe(true);
      expect(res.body.partner).toBe('partner_a');
    });

    it('PATCH /admin/partners/:slug succeeds with Authorization: Bearer <key>', async () => {
      if (!servicesReady) return;

      const res = await request(app.getHttpServer())
        .patch('/admin/partners/partner_a')
        .set('Authorization', `Bearer ${adminApiKey}`)
        .send({ status: 'DISABLED' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('DISABLED');
    });
  });
});
