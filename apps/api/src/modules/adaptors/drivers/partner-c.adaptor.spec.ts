import { createHmac } from 'node:crypto';
import { PartnerCAdaptor } from './partner-c.adaptor.js';

describe('PartnerCAdaptor - Security & Signature Verification', () => {
  let adaptor: PartnerCAdaptor;
  const testSecret = 'c8f126f5e92be2b1a8f940821d3e86f8';

  beforeEach(() => {
    process.env.PARTNER_C_HMAC_SECRET = testSecret;
    adaptor = new PartnerCAdaptor();
  });

  it('should accept valid signature matching payload and current timestamp', async () => {
    const rawBody = JSON.stringify({ reservation: { booking_ref: 'STAR-123' } });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', testSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const headers = {
      'x-starlight-signature': signature,
      'x-starlight-timestamp': timestamp,
      'x-starlight-event-id': 'evt_valid_1',
    };

    const result = await adaptor.verifyWebhook(headers, rawBody);
    expect(result.isValid).toBe(true);
    expect(result.idempotencyKey).toBe('partner_c:evt_valid_1');
  });

  it('should reject tampered payload even with a valid timestamp', async () => {
    const originalBody = JSON.stringify({ reservation: { booking_ref: 'STAR-123' } });
    const tamperedBody = JSON.stringify({ reservation: { booking_ref: 'STAR-HACKED' } });
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const signature = createHmac('sha256', testSecret)
      .update(`${timestamp}.${originalBody}`)
      .digest('hex');

    const headers = {
      'x-starlight-signature': signature,
      'x-starlight-timestamp': timestamp,
      'x-starlight-event-id': 'evt_tampered_1',
    };

    const result = await adaptor.verifyWebhook(headers, tamperedBody);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Cryptographic signature verification failed');
  });

  it('should reject replay attacks when timestamp drift exceeds 300 seconds', async () => {
    const rawBody = JSON.stringify({ reservation: { booking_ref: 'STAR-123' } });
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 400).toString(); // 400s old

    const signature = createHmac('sha256', testSecret)
      .update(`${staleTimestamp}.${rawBody}`)
      .digest('hex');

    const headers = {
      'x-starlight-signature': signature,
      'x-starlight-timestamp': staleTimestamp,
      'x-starlight-event-id': 'evt_stale_1',
    };

    const result = await adaptor.verifyWebhook(headers, rawBody);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('drift exceeded 300 seconds');
  });
});