import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SyncJobStatus, PartnerStatus } from '@cih/database';

export class UpdatePartnerStatusDto {
  @ApiPropertyOptional({
    description: 'Target partner operational status',
    enum: PartnerStatus,
    example: PartnerStatus.ACTIVE,
  })
  status?: PartnerStatus;

  @ApiPropertyOptional({
    description: 'Convenience flag to enable/disable the partner (maps to ACTIVE / DISABLED)',
    example: true,
  })
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Alias for enabled: true',
    example: true,
  })
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Alias for enabled: false',
    example: false,
  })
  disabled?: boolean;
}

export class ResolveDriftDto {
  @ApiProperty({
    description: 'Resolution action to apply to the drift item',
    enum: ['ACCEPT_PARTNER', 'KEEP_CANONICAL', 'DISMISS'],
    example: 'ACCEPT_PARTNER',
  })
  action!: 'ACCEPT_PARTNER' | 'KEEP_CANONICAL' | 'DISMISS';
}

export class GetJobsQueryDto {
  @ApiPropertyOptional({
    description: 'Filter jobs by status',
    enum: SyncJobStatus,
    example: SyncJobStatus.FAILED,
  })
  status?: SyncJobStatus;

  @ApiPropertyOptional({
    description: 'Maximum number of jobs to return (default 50, max 100)',
    example: 50,
  })
  take?: string;
}

export class GetReconciliationLogsQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum number of drift logs to return (default 50, max 100)',
    example: 50,
  })
  take?: string;
}
