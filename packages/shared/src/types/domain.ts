export enum PartnerAuthType {
  API_KEY = 'API_KEY',
  OAUTH2 = 'OAUTH2',
  HMAC_SIGNATURE = 'HMAC_SIGNATURE',
}

export enum PartnerStatus {
  ACTIVE = 'ACTIVE',
  DEGRADED = 'DEGRADED',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  DISABLED = 'DISABLED',
}

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
}

export interface CanonicalReservationPayload {
  reservationId: string;
  externalBookingId: string;
  propertyId: string;
  inventoryUnitCode: string;
  checkInDate: string;  // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
  unitsBooked: number;
  guestName: string;
  guestEmail?: string;
  totalPriceCents: number;
  currency: string;
  status: ReservationStatus;
  metadata?: Record<string, unknown>;
}

export interface CanonicalInventoryPushPayload {
  propertyId: string;
  inventoryUnitCode: string;
  date: string; // YYYY-MM-DD
  availableUnits: number;
  priceInCents: number;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  partnerSlug: string;
  idempotencyKey?: string;
  rawPayload: unknown;
  error?: string;
}

export interface DriftDetectionResult {
  partnerSlug: string;
  entityType: 'RESERVATION' | 'INVENTORY';
  entityId: string;
  canonicalValue: unknown;
  partnerValue: unknown;
  driftDescription: string;
  requiresAction: boolean;
}