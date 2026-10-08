import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SchemaMapperService } from './schema-mapper.service.js';
import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard.js';
import {
  ProposeMappingDto,
  ApplyMappingDto,
  MappingProposalResponseDto,
} from './dto/schema-mapper.dto.js';

@ApiTags('Schema Mapper')
@ApiSecurity('AdminApiKey')
@Controller('admin/schema-mapper')
@UseGuards(AdminApiKeyGuard)
export class SchemaMapperController {
  constructor(private readonly mapperService: SchemaMapperService) {}

  @Post('propose/:partnerSlug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Propose schema mapping for partner payload',
    description:
      'Uses OpenAI LLM (or deterministic heuristic fallback) to analyze an inbound partner JSON payload and propose field mappings to the canonical reservation schema.',
  })
  @ApiParam({ name: 'partnerSlug', description: 'Partner slug (e.g. partner_a, partner_b)', example: 'partner_d' })
  @ApiBody({ type: ProposeMappingDto, description: 'Sample partner payload to analyze' })
  @ApiOkResponse({
    description: 'Field mapping proposal with confidence scores and notes.',
    type: MappingProposalResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing admin API key.' })
  @ApiBadRequestResponse({ description: 'Invalid partner slug or payload.' })
  proposeMapping(
    @Param('partnerSlug') partnerSlug: string,
    @Body() body: ProposeMappingDto | Record<string, unknown>,
  ) {
    const payload = (body && 'samplePayload' in body) ? (body as ProposeMappingDto).samplePayload : body;
    return this.mapperService.proposeMapping(partnerSlug, payload as Record<string, unknown>);
  }

  @Post('apply/:mappingId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply and persist approved schema mapping',
    description:
      'Persists the reviewed and approved canonical field mappings into the PropertyPartnerMapping entity.',
  })
  @ApiParam({ name: 'mappingId', description: 'PropertyPartnerMapping UUID', format: 'uuid' })
  @ApiBody({ type: ApplyMappingDto, description: 'Approved field mapping definition' })
  @ApiOkResponse({ description: 'PropertyPartnerMapping successfully updated with approved field mapping.' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing admin API key.' })
  @ApiBadRequestResponse({ description: 'Mapping record not found or invalid format.' })
  applyMapping(
    @Param('mappingId') mappingId: string,
    @Body() body: ApplyMappingDto | Record<string, unknown>,
  ) {
    const mapping = (body && 'approvedMapping' in body) ? (body as ApplyMappingDto).approvedMapping : body;
    return this.mapperService.applyMapping(mappingId, mapping as Record<string, unknown>);
  }
}

