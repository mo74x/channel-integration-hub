import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prisma } from '@cih/database';
import { SchemaMapperService } from './schema-mapper.service.js';

jest.mock('@cih/database', () => ({
  prisma: {
    propertyPartnerMapping: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe('SchemaMapperService', () => {
  let service: SchemaMapperService;
  let mockConfig: jest.Mocked<ConfigService>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'OPENAI_API_KEY') return undefined; // Default no key
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    service = new SchemaMapperService(mockConfig);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('proposeMapping - Heuristic Fallback', () => {
    it('returns heuristic fallback when OPENAI_API_KEY is not configured', async () => {
      const payload = {
        booking_id: 'BK-1234',
        guest_name: 'John Doe',
        arrival_date: '2026-11-01',
        departure_date: '2026-11-05',
      };

      const result = await service.proposeMapping('partner_test', payload);

      expect(result.summary).toContain('Heuristic pattern matching');
      expect(result.fieldMappings.externalBookingId.sourcePath).toBe('booking_id');
      expect(result.fieldMappings.externalBookingId.confidence).toBe(0.9);
      expect(result.fieldMappings.guestName.sourcePath).toBe('guest_name');
    });

    it('falls back to nested keys in heuristic mode when primary keys absent', async () => {
      const payload = {
        id: '123',
        customer: { name: 'Alice' },
      };

      const result = await service.proposeMapping('partner_test', payload);

      expect(result.fieldMappings.externalBookingId.sourcePath).toBe('id');
      expect(result.fieldMappings.guestName.sourcePath).toBe('customer.name');
      expect(result.fieldMappings.checkInDate.sourcePath).toBe('dates.check_in');
    });
  });

  describe('proposeMapping - OpenAI API', () => {
    it('calls OpenAI endpoint and returns validated proposal when API key is present', async () => {
      mockConfig.get.mockReturnValue('test-openai-key');
      service = new SchemaMapperService(mockConfig);

      const aiProposal = {
        fieldMappings: {
          externalBookingId: { sourcePath: 'pms.ref', confidence: 0.95 },
          guestName: { sourcePath: 'pms.guest.full_name', confidence: 0.9 },
        },
        customTransformations: ['multiply rate by 100'],
        summary: 'Mapped PMS schema via AI model',
      };

      const mockResponse = new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(aiProposal),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.proposeMapping('partner_ai', { pms: { ref: 'P-1' } });

      expect(result.summary).toBe('Mapped PMS schema via AI model');
      expect(result.fieldMappings.externalBookingId.sourcePath).toBe('pms.ref');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-openai-key',
          }),
        }),
      );
    });

    it('falls back to heuristic mapping when OpenAI API returns non-200 or throws', async () => {
      mockConfig.get.mockReturnValue('test-openai-key');
      service = new SchemaMapperService(mockConfig);

      global.fetch = jest.fn().mockRejectedValue(new Error('Network error calling OpenAI'));

      const result = await service.proposeMapping('partner_ai', { booking_id: 'FALLBACK-1' });

      expect(result.summary).toContain('Heuristic pattern matching');
      expect(result.fieldMappings.externalBookingId.sourcePath).toBe('booking_id');
    });
  });

  describe('applyMapping', () => {
    it('updates propertyPartnerMapping with approved field mapping', async () => {
      (prisma.propertyPartnerMapping.findUnique as jest.Mock).mockResolvedValue({
        id: 'map-1',
        partnerId: 'part-1',
      });
      (prisma.propertyPartnerMapping.update as jest.Mock).mockResolvedValue({
        id: 'map-1',
        fieldMapping: { booking_id: 'externalBookingId' },
      });

      const mapping = { booking_id: 'externalBookingId' };
      const updated = await service.applyMapping('map-1', mapping);

      expect(prisma.propertyPartnerMapping.update).toHaveBeenCalledWith({
        where: { id: 'map-1' },
        data: { fieldMapping: mapping },
      });
      expect(updated.id).toBe('map-1');
    });

    it('throws BadRequestException if propertyPartnerMapping record is not found', async () => {
      (prisma.propertyPartnerMapping.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.applyMapping('unknown-map', {})).rejects.toThrow(BadRequestException);
    });
  });
});
