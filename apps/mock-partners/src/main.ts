import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const logger = new Logger('MockPartnersServer');
  const app = await NestFactory.create(AppModule);

  const port = process.env.MOCK_PARTNERS_PORT || 4000;
  await app.listen(port);
  logger.log(`Mock Partners simulation server running at http://localhost:${port}`);
}

bootstrap();