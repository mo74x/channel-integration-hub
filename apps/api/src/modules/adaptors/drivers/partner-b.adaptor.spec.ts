import { ConfigService } from '@nestjs/config';
import { PartnerBAdaptor } from './partner-b.adaptor.js';

describe('PartnerBAdaptor', () => {
  let adaptor: PartnerBAdaptor;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'PARTNER_B_CLIENT_ID') return 'test_client_id';
        if (key === 'PARTNER_B_CLIENT_SECRET') return 'test_client_secret';
        if (key === 'PARTNER_B_BASE_URL') return 'http://localhost:4000/partner-b';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    adaptor = new PartnerBAdaptor(mockConfigService);
  });

  it('exposes correct capabilities for polling-only architecture', () => {
    expect(adaptor.capabilities).toEqual({
      webhooks: false,
      polling: true,
      inventoryPush: false,
    });
  });

  it('declares webhooks unsupported', async () => {
    const result = await adaptor.verifyWebhook();
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Polling architecture only');
  });
});
