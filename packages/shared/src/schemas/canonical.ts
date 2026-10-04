import { z } from 'zod';
import { ReservationStatus } from '../types/domain.js';

export const CanonicalReservationSchema = z.object({
  reservationId: z.string().uuid(),
  externalBookingId: z.string().min(1),
  propertyId: z.string().uuid(),
  inventoryUnitCode: z.string().min(1),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  unitsBooked: z.number().int().positive(),
  guestName: z.string().min(1),
  guestEmail: z.string().email().optional(),
  totalPriceCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.nativeEnum(ReservationStatus),
  metadata: z.record(z.unknown()).optional(),
});

export const CanonicalInventoryPushSchema = z.object({
  propertyId: z.string().uuid(),
  inventoryUnitCode: z.string().min(1), 
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  availableUnits: z.number().int().nonnegative(),
  priceInCents: z.number().int().positive(),
});

export type CanonicalReservationDTO = z.infer<typeof CanonicalReservationSchema>;
export type CanonicalInventoryPushDTO = z.infer<typeof CanonicalInventoryPushSchema>;