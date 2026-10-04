import { CanonicalReservationPayload, CanonicalInventoryPushPayload } from '@cih/shared';

export interface WebhookValidationResult {
  isValid: boolean;
  idempotencyKey?: string;
  error?: string;
  parsedBody?: any;
}

export interface PartnerAdaptor {
  readonly partnerSlug: string;

  /**
   * Validates authenticity (HMAC signature, Bearer token, or API Key).
   */
  verifyWebhook(headers: Record<string, string | string[]>, rawBody: Buffer | string): Promise<WebhookValidationResult>;

  /**
   * Normalizes inbound heterogeneous payloads into the canonical reservation format.
   */
  transformInboundReservation(rawPayload: any): Promise<Omit<CanonicalReservationPayload, 'reservationId'>>;

  /**
   * Sends availability updates to the partner system.
   */
  pushInventory(update: CanonicalInventoryPushPayload): Promise<{ success: boolean; partnerSyncId?: string }>;

  /**
   * Pulls current remote reservations for batch reconciliation.
   */
  pullReservations(externalPropertyId: string, since?: Date): Promise<Array<Omit<CanonicalReservationPayload, 'reservationId'>>>;
}