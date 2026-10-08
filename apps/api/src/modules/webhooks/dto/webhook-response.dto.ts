import { ApiProperty } from '@nestjs/swagger';

export class WebhookAcknowledgmentDto {
  @ApiProperty({
    description: 'Whether the webhook was acknowledged and processed',
    example: true,
  })
  acknowledged!: boolean;

  @ApiProperty({
    description: 'Internal reservation UUID created or updated by this webhook',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  reservationId!: string;

  @ApiProperty({
    description: 'Current status of the canonical reservation',
    example: 'CONFIRMED',
  })
  status!: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp of acknowledgment',
    example: '2026-10-08T00:00:00.000Z',
  })
  timestamp!: string;
}
