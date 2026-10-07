import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // Preserves raw buffer on requests for HMAC-SHA256 signature verification
  });

  // Enable graceful shutdown hooks for container lifecycle & DB/Redis cleanup
  app.enableShutdownHooks();

  // Helmet middleware for HTTP security headers
  app.use(helmet());

  // CORS for the web dashboard and partner clients
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:4000'];

  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? allowedOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-admin-api-key',
      'x-api-key',
      'X-API-KEY',
      'x-admin-key',
      'x-request-id',
      'x-idempotency-key',
      'x-starlight-signature',
      'x-starlight-timestamp',
      'x-starlight-event-id',
    ],
    credentials: true,
  });

  // Global exception filter for standardized API error responses
  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.API_PORT || 3000;
  await app.listen(port);
  logger.log(`Channel Integration Hub API listening on port ${port}`);
}

bootstrap();
