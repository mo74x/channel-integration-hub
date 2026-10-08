import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProposeMappingDto {
  @ApiProperty({
    description: 'Sample JSON payload from the partner booking or webhook response to analyze and map to the canonical schema',
    example: {
      booking_reference: 'BK-99120',
      room_type_code: 'DLX_OCEAN',
      check_in: '2026-12-01',
      check_out: '2026-12-05',
      num_rooms: 1,
      guest: {
        full_name: 'Jane Doe',
        email_address: 'jane.doe@example.com',
      },
      payment: {
        total_amount: 54000,
        currency_code: 'USD',
      },
      booking_status: 'CONFIRMED',
    },
  })
  samplePayload!: Record<string, unknown>;
}

export class FieldMappingDefinitionDto {
  @ApiProperty({
    description: 'JSONPath or dot-notation path in the partner payload',
    example: 'booking_reference',
  })
  sourcePath!: string;

  @ApiProperty({
    description: 'Confidence score of the proposed mapping (0.0 to 1.0)',
    example: 0.95,
  })
  confidence!: number;

  @ApiPropertyOptional({
    description: 'Optional engineering notes or transformation advice',
    example: 'Exact key match',
  })
  notes?: string;
}

export class MappingProposalResponseDto {
  @ApiProperty({
    description: 'Proposed field mappings mapping canonical field names to partner payload paths',
    type: Object,
  })
  fieldMappings!: Record<string, FieldMappingDefinitionDto>;

  @ApiPropertyOptional({
    description: 'Custom transformations or normalization functions needed',
    type: [String],
  })
  customTransformations?: string[];

  @ApiProperty({
    description: 'Human-readable summary of the mapping proposal',
    example: 'Successfully mapped 10 canonical fields with average confidence 0.92',
  })
  summary!: string;
}

export class ApplyMappingDto {
  @ApiProperty({
    description: 'Approved field mapping dictionary to persist to PropertyPartnerMapping',
    example: {
      fieldMappings: {
        externalBookingId: { sourcePath: 'booking_reference', confidence: 1.0 },
        guestName: { sourcePath: 'guest.full_name', confidence: 1.0 },
        guestEmail: { sourcePath: 'guest.email_address', confidence: 1.0 },
        totalPriceCents: { sourcePath: 'payment.total_amount', confidence: 1.0 },
        currency: { sourcePath: 'payment.currency_code', confidence: 1.0 },
        inventoryUnitCode: { sourcePath: 'room_type_code', confidence: 1.0 },
        checkInDate: { sourcePath: 'check_in', confidence: 1.0 },
        checkOutDate: { sourcePath: 'check_out', confidence: 1.0 },
      },
    },
  })
  approvedMapping!: Record<string, unknown>;
}
