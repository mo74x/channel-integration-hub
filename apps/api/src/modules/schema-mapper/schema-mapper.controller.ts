import { Body, Controller, Param, Post } from '@nestjs/common';
import { SchemaMapperService } from './schema-mapper.service.js';

@Controller('admin/schema-mapper')
export class SchemaMapperController {
  constructor(private readonly mapperService: SchemaMapperService) {}

  @Post('propose/:partnerSlug')
  proposeMapping(
    @Param('partnerSlug') partnerSlug: string,
    @Body() samplePayload: Record<string, unknown>,
  ) {
    return this.mapperService.proposeMapping(partnerSlug, samplePayload);
  }

  @Post('apply/:mappingId')
  applyMapping(
    @Param('mappingId') mappingId: string,
    @Body() approvedMapping: Record<string, unknown>,
  ) {
    return this.mapperService.applyMapping(mappingId, approvedMapping);
  }
}