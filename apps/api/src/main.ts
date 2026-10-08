import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  // OpenAPI / Swagger documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Channel Integration Hub')
    .setDescription(
      'Unified hospitality channel manager API — normalises heterogeneous OTA / booking-engine partner APIs behind a single canonical data model.\n\n' +
        '## Authentication\n' +
        '- **Admin endpoints** (`/admin/*`) require the `x-admin-api-key` header.\n' +
        '- **Webhook endpoints** (`/webhooks/:slug`) are authenticated per-partner (API-Key, OAuth2, or HMAC-SHA256).\n' +
        '- **Inventory & Reservation** endpoints are currently unauthenticated (intended for internal / VPC use).',
    )
    .setVersion('1.0.0')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addApiKey(
      { type: 'apiKey', name: 'x-admin-api-key', in: 'header', description: 'Admin API key' },
      'AdminApiKey',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header',
        description: 'Partner API key (webhook ingestion)',
      },
      'PartnerApiKey',
    )
    .addTag('Health', 'Liveness and readiness probes')
    .addTag('Webhooks', 'Inbound partner reservation webhooks')
    .addTag('Inventory', 'Availability calendar management')
    .addTag('Reservations', 'Reservation queries')
    .addTag('Admin', 'Partner management, job control, circuit breakers and drift resolution')
    .addTag('Schema Mapper', 'AI-assisted partner payload field mapping')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'method',
    },
    customSiteTitle: 'CIH API Docs',
  });

  const port = process.env.API_PORT || 3000;
  await app.listen(port);
  logger.log(`Channel Integration Hub API listening on port ${port}`);
  logger.log(`OpenAPI docs available at http://localhost:${port}/docs`);
}

bootstrap();
