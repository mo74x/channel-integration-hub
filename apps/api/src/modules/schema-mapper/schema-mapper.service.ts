import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prisma } from '@cih/database';
import { z } from 'zod';

const MappingProposalSchema = z.object({
  fieldMappings: z.record(
    z.string(),
    z.object({
      sourcePath: z.string().describe('JSONPath or dot-notation path in partner payload'),
      confidence: z.number().min(0).max(1),
      notes: z.string().optional(),
    }),
  ),
  customTransformations: z.array(z.string()).optional(),
  summary: z.string(),
});

export type MappingProposal = z.infer<typeof MappingProposalSchema>;

@Injectable()
export class SchemaMapperService {
  private readonly logger = new Logger(SchemaMapperService.name);
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('OPENAI_API_KEY');
  }

  /**
   * Prompts the LLM with a partner sample payload to propose field mappings against canonical fields.
   */
  async proposeMapping(
    partnerSlug: string,
    samplePayload: Record<string, unknown>,
  ): Promise<MappingProposal> {
    if (!this.apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY is not set. Generating deterministic heuristic fallback mapping.',
      );
      return this.heuristicFallback(samplePayload);
    }

    const systemPrompt = `You are a Forward Deployed Integration Engineer specializing in channel managers and PMS data transformations.
Your task is to inspect an external partner's reservation payload and map it to our canonical schema:
- externalBookingId (string)
- inventoryUnitCode (string, e.g. room category)
- checkInDate (YYYY-MM-DD)
- checkOutDate (YYYY-MM-DD)
- unitsBooked (integer)
- guestName (string)
- guestEmail (string)
- totalPriceCents (integer in smallest currency unit)
- currency (ISO 3-letter code)
- status ('CONFIRMED' | 'CANCELLED' | 'PENDING')

Return strict JSON adhering to the schema.`;

    const userPrompt = `Partner Slug: ${partnerSlug}
Sample Partner Payload:
${JSON.stringify(samplePayload, null, 2)}`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'mapping_proposal',
              schema: {
                type: 'object',
                properties: {
                  fieldMappings: {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      properties: {
                        sourcePath: { type: 'string' },
                        confidence: { type: 'number' },
                        notes: { type: 'string' },
                      },
                      required: ['sourcePath', 'confidence'],
                    },
                  },
                  customTransformations: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  summary: { type: 'string' },
                },
                required: ['fieldMappings', 'summary'],
              },
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API returned HTTP ${response.status}`);
      }

      const completion = (await response.json()) as any;
      const content = completion.choices?.[0]?.message?.content;
      const parsed = JSON.parse(content);
      return MappingProposalSchema.parse(parsed);
    } catch (error: any) {
      this.logger.error(
        `AI mapping generation failed: ${error.message}. Returning heuristic mapping.`,
      );
      return this.heuristicFallback(samplePayload);
    }
  }

  /**
   * Commits the reviewed and approved mapping to the database.
   */
  async applyMapping(propertyPartnerMappingId: string, approvedMapping: Record<string, unknown>) {
    const record = await prisma.propertyPartnerMapping.findUnique({
      where: { id: propertyPartnerMappingId },
    });

    if (!record) {
      throw new BadRequestException(
        `PropertyPartnerMapping '${propertyPartnerMappingId}' not found`,
      );
    }

    return prisma.propertyPartnerMapping.update({
      where: { id: propertyPartnerMappingId },
      data: {
        fieldMapping: approvedMapping as object,
      },
    });
  }

  /**
   * Deterministic fallback when an LLM key is absent or unreachable.
   */
  private heuristicFallback(payload: Record<string, unknown>): MappingProposal {
    return {
      fieldMappings: {
        externalBookingId: {
          sourcePath: payload.booking_id ? 'booking_id' : 'id',
          confidence: payload.booking_id || payload.id ? 0.9 : 0.3,
          notes: 'Derived via fallback key matching',
        },
        guestName: {
          sourcePath: payload.guest_name ? 'guest_name' : 'customer.name',
          confidence: 0.8,
        },
        checkInDate: {
          sourcePath: payload.arrival_date ? 'arrival_date' : 'dates.check_in',
          confidence: 0.85,
        },
        checkOutDate: {
          sourcePath: payload.departure_date ? 'departure_date' : 'dates.check_out',
          confidence: 0.85,
        },
      },
      summary: 'Heuristic pattern matching applied without LLM inference.',
    };
  }
}
