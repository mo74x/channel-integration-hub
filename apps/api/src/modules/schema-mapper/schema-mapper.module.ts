import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SchemaMapperService } from './schema-mapper.service.js';
import { SchemaMapperController } from './schema-mapper.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [SchemaMapperController],
  providers: [SchemaMapperService],
  exports: [SchemaMapperService],
})
export class SchemaMapperModule {}
