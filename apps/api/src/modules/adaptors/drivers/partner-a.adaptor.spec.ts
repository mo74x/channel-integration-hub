import { ConfigService } from '@nestjs/config';
import { PartnerAAdaptor } from './partner-a.adaptor.js';

describe('PartnerAAdaptor', () => {
  let adaptor: PartnerAAdaptor;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'PARTNER_A_API_KEY') return 'test_partner_a_secret_key';
        if (key === 'PARTNER_A_BASE_URL') return 'http://localhost:4000/partner-a';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    adaptor = new PartnerAAdaptor(mockConfigService);
  });

  it('exposes correct capabilities', () => {
    expect(adaptor.capabilities).toEqual({
      webhooks: true,
      polling: false,
      inventoryPush: true,
    });
  });

  it('validates webhook successfully with timing-safe comparison when key matches', async () => {
    const headers = { 'x-api-key': 'test_partner_a_secret_key', 'x-idempotency-key': 'idem-1' };
    const rawBody = JSON.stringify({ booking_reference: 'A-123' });

    const result = await adaptor.verifyWebhook(headers, rawBody);
    expect(result.isValid).toBe(true);
    expect(result.idempotencyKey).toBe('partner_a:idem-1');
  });

  it('rejects webhook with invalid API key', async () => {
    const headers = { 'x-api-key': 'wrong_invalid_key' };
    const rawBody = JSON.stringify({ booking_reference: 'A-123' });

    const result = await adaptor.verifyWebhook(headers, rawBody);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Unauthorized');
  });

  it('rejects webhook when API key header is missing', async () => {
    const headers = {};
    const rawBody = JSON.stringify({ booking_reference: 'A-123' });

    const result = await adaptor.verifyWebhook(headers, rawBody);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Unauthorized');
  });
});
