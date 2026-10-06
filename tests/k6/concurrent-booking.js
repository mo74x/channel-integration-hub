import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';

export const options = {
  scenarios: {
    last_unit_race_condition: {
      executor: 'shared-iterations',
      vus: 30,             // 30 concurrent client threads
      iterations: 30,      // Exactly 30 booking attempts
      maxDuration: '15s',
    },
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const HMAC_SECRET = __ENV.PARTNER_C_HMAC_SECRET ;

export default function () {
  const vuId = __VU;
  const iterId = __ITER;
  const uniqueBookingRef = `RACE-BOOK-${vuId}-${iterId}-${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const eventId = `evt_race_${vuId}_${iterId}`;

  // Target the seeded date '2026-11-10' for DELUXE_KING
  const payloadObject = {
    event_meta: {
      event_id: eventId,
      timestamp: timestamp,
      publisher: 'Starlight Engine Load Tester',
    },
    reservation: {
      booking_ref: uniqueBookingRef,
      resort_id: 'EXT-PROP-C-303',
      unit_type: 'DELUXE_KING',
      guest: {
        name: `Concurrent Guest ${vuId}`,
        contact: `guest${vuId}@loadtest.local`,
      },
      stay: {
        arrival: '2026-11-10',
        departure: '2026-11-11',
        quantity: 1,
      },
      pricing: {
        charged_amount_cents: 25000,
        currency: 'USD',
      },
      lifecycle_state: 'CONFIRMED',
    },
  };

  const payloadString = JSON.stringify(payloadObject);

  // Generate valid HMAC signature
  const signature = crypto.hmac('sha256', HMAC_SECRET, `${timestamp}.${payloadString}`, 'hex');

  const headers = {
    'content-type': 'application/json',
    'x-starlight-signature': signature,
    'x-starlight-timestamp': timestamp,
    'x-starlight-event-id': eventId,
  };

  const res = http.post(`${BASE_URL}/webhooks/partner_c`, payloadString, { headers });

  // Each response should be either 200 (Success) or 400 (Capacity exhausted / out of inventory)
  check(res, {
    'Status is 200 (Booked) or 400 (Sold out)': (r) => r.status === 200 || r.status === 400,
    'No 500 internal server errors': (r) => r.status !== 500,
  });

  sleep(0.1);
}