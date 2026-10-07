-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PartnerAuthType" AS ENUM ('API_KEY', 'OAUTH2', 'HMAC_SIGNATURE');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'CIRCUIT_OPEN', 'DISABLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('INBOUND_WEBHOOK', 'OUTBOUND_PUSH', 'SCHEDULED_POLL');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "DriftResolution" AS ENUM ('AUTO_CORRECTED', 'FLAGGED_FOR_REVIEW', 'DISMISSED');

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authType" "PartnerAuthType" NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "webhookSecret" TEXT,
    "apiKey" TEXT,
    "oauthConfig" JSONB,
    "rateLimitConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_partner_mappings" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalPropertyId" TEXT NOT NULL,
    "fieldMapping" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_partner_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_units" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "externalCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_calendar" (
    "id" TEXT NOT NULL,
    "inventoryUnitId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "availableUnits" INTEGER NOT NULL,
    "priceInCents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "inventoryUnitId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalBookingId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "checkInDate" DATE NOT NULL,
    "checkOutDate" DATE NOT NULL,
    "unitsBooked" INTEGER NOT NULL DEFAULT 1,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT,
    "totalPriceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rawPayload" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "jobType" "SyncJobType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_logs" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "canonicalData" JSONB NOT NULL,
    "partnerData" JSONB NOT NULL,
    "driftDetail" JSONB NOT NULL,
    "resolution" "DriftResolution" NOT NULL DEFAULT 'FLAGGED_FOR_REVIEW',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_slug_key" ON "partners"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "property_partner_mappings_propertyId_partnerId_key" ON "property_partner_mappings"("propertyId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "property_partner_mappings_partnerId_externalPropertyId_key" ON "property_partner_mappings"("partnerId", "externalPropertyId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_units_propertyId_externalCode_key" ON "inventory_units"("propertyId", "externalCode");

-- CreateIndex
CREATE INDEX "inventory_calendar_date_idx" ON "inventory_calendar"("date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_calendar_inventoryUnitId_date_key" ON "inventory_calendar"("inventoryUnitId", "date");

-- CreateIndex
CREATE INDEX "reservations_checkInDate_checkOutDate_idx" ON "reservations"("checkInDate", "checkOutDate");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_partnerId_externalBookingId_key" ON "reservations"("partnerId", "externalBookingId");

-- CreateIndex
CREATE INDEX "idempotency_records_lockedUntil_idx" ON "idempotency_records"("lockedUntil");

-- CreateIndex
CREATE INDEX "sync_jobs_partnerId_status_idx" ON "sync_jobs"("partnerId", "status");

-- CreateIndex
CREATE INDEX "reconciliation_logs_partnerId_resolution_idx" ON "reconciliation_logs"("partnerId", "resolution");

-- AddForeignKey
ALTER TABLE "property_partner_mappings" ADD CONSTRAINT "property_partner_mappings_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_partner_mappings" ADD CONSTRAINT "property_partner_mappings_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_units" ADD CONSTRAINT "inventory_units_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_calendar" ADD CONSTRAINT "inventory_calendar_inventoryUnitId_fkey" FOREIGN KEY ("inventoryUnitId") REFERENCES "inventory_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_inventoryUnitId_fkey" FOREIGN KEY ("inventoryUnitId") REFERENCES "inventory_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_logs" ADD CONSTRAINT "reconciliation_logs_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
