# Operations Runbook

> Procedures for common operational tasks. All `curl` examples assume the API runs at `localhost:3000`.

[⬅ Back to README](../README.md) · [Architecture & Diagrams](ARCHITECTURE.md) · [Adding a Partner](ADDING_A_PARTNER.md)

---

## Table of Contents

1. [Health Checks](#1-health-checks)
2. [Replaying Dead-Letter Queue Jobs](#2-replaying-dead-letter-queue-jobs)
3. [Resetting Circuit Breakers](#3-resetting-circuit-breakers)
4. [Enabling / Disabling Partners](#4-enabling--disabling-partners)
5. [Resolving Drift](#5-resolving-drift)
6. [Triggering a Reconciliation Sweep](#6-triggering-a-reconciliation-sweep)
7. [Rotating Secrets](#7-rotating-secrets)
8. [Database Operations](#8-database-operations)
9. [Redis Inspection](#9-redis-inspection)
10. [Viewing Logs](#10-viewing-logs)

---

## 1. Health Checks

### Liveness (is the process alive?)

```bash
curl -s http://localhost:3000/health/live | jq
```

Returns `200 OK` if the NestJS process is running. Use this for Kubernetes liveness probes — it does **not** check external dependencies.

### Readiness (is the system ready to serve traffic?)

```bash
curl -s http://localhost:3000/health/ready | jq
```

Checks Postgres connectivity and Redis connectivity. Returns `200 OK` only when both dependencies are healthy.

**Kubernetes probe config example:**

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 10
```

---

## 2. Replaying Dead-Letter Queue Jobs

When a sync job exhausts its retries (5 attempts with exponential backoff) or hits an unrecoverable 4xx error, it moves to `DEAD_LETTER` status.

### List failed / dead-letter jobs

```bash
# All failed jobs
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/jobs?status=FAILED" | jq

# Dead-letter jobs only
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/jobs?status=DEAD_LETTER" | jq
```

### Inspect a specific job

Look at the `lastError`, `attempts`, `payload` and `partner` fields to diagnose the root cause.

### Replay a job

```bash
curl -s -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/jobs/<JOB_ID>/replay" | jq
```

This:
1. Resets the job status to `QUEUED`.
2. Clears `lastError`.
3. Re-enqueues the job into BullMQ with fresh retry budget (5 attempts, exponential backoff).

> **Tip**: Fix the underlying issue first (e.g. reset a tripped circuit, fix partner credentials) before replaying.

### Bulk replay (scripted)

```bash
# Replay all DEAD_LETTER jobs for a specific partner
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/jobs?status=DEAD_LETTER&take=100" | \
  jq -r '.[].id' | \
  xargs -I{} curl -s -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
    "http://localhost:3000/admin/jobs/{}/replay"
```

---

## 3. Resetting Circuit Breakers

When a partner's API recovers but the circuit is still OPEN, manually reset it:

### Check circuit status

```bash
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/partners" | jq '.[].{slug, circuitState, consecutiveFailures}'
```

### Force-reset a circuit

```bash
curl -s -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/partners/partner_a/circuit/reset" | jq
```

This:
1. Sets the circuit state to `CLOSED`.
2. Clears the failure counter, `opened_at` timestamp and probe lock in Redis.
3. If the partner's DB status was `CIRCUIT_OPEN`, restores it to `ACTIVE`.

### Direct Redis inspection

```bash
# Check raw circuit state
redis-cli -a "$REDIS_PASSWORD" GET circuit:partner_a:state
redis-cli -a "$REDIS_PASSWORD" GET circuit:partner_a:failures

# Manual emergency reset (bypasses API)
redis-cli -a "$REDIS_PASSWORD" DEL circuit:partner_a:state circuit:partner_a:failures circuit:partner_a:opened_at circuit:partner_a:probe_lock
```

---

## 4. Enabling / Disabling Partners

### Disable a partner (stop all sync and webhook processing)

```bash
curl -s -X PATCH -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"status": "DISABLED"}' \
  "http://localhost:3000/admin/partners/partner_b" | jq
```

### Re-enable a partner

```bash
curl -s -X PATCH -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"status": "ACTIVE"}' \
  "http://localhost:3000/admin/partners/partner_b" | jq
```

> Re-enabling also force-resets the circuit breaker for that partner.

---

## 5. Resolving Drift

Drift logs are created by the reconciliation service when it detects mismatches between the canonical DB and partner state.

### View drift logs

```bash
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/reconciliation-logs?take=20" | jq
```

### Resolve a drift log

Three resolution actions are available:

| Action | Effect |
|---|---|
| `ACCEPT_PARTNER` | Applies the partner's version through the reservation state machine (may adjust inventory). |
| `KEEP_CANONICAL` | Marks canonical DB as the source of truth; no data changes. |
| `DISMISS` | Ignores the drift — marks log as dismissed. |

```bash
curl -s -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"action": "ACCEPT_PARTNER"}' \
  "http://localhost:3000/admin/reconciliation-logs/<LOG_ID>/resolve" | jq
```

---

## 6. Triggering a Reconciliation Sweep

Manually trigger a drift reconciliation against a partner's external API:

```bash
curl -s -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  "http://localhost:3000/admin/reconcile/partner_c" | jq
```

Returns the number of drift items detected:

```json
{
  "partnerSlug": "partner_c",
  "driftDetected": 2
}
```

> Reconciliation pulls remote reservations via `pullReservations()` and compares against the local DB.

---

## 7. Rotating Secrets

### Partner API keys

1. Generate a new key on the partner's portal.
2. Update the environment variable (e.g. `PARTNER_A_API_KEY`).
3. Restart the API service:
   ```bash
   # Docker Compose
   docker compose -f docker-compose.full.yml restart api

   # Or rolling restart in k8s
   kubectl rollout restart deployment/cih-api
   ```
4. Verify with a test webhook or check `/admin/partners` for circuit state.

### Admin API key

1. Set a new value for `ADMIN_API_KEY`.
2. Restart the API.
3. Update any CI/CD pipelines, dashboards or monitoring tools that use the old key.
4. Update `NEXT_PUBLIC_ADMIN_API_KEY` for the web dashboard and rebuild.

### HMAC secrets (Partner C)

1. Coordinate with the partner to rotate the shared secret.
2. Update `PARTNER_C_HMAC_SECRET` in `.env`.
3. Restart the API.
4. The next webhook from Partner C will be validated against the new secret.

### Database password

1. Update the password in PostgreSQL.
2. Update `DATABASE_URL` and `POSTGRES_PASSWORD` in `.env`.
3. Restart all services.

### Redis password

1. Update the Redis server config.
2. Update `REDIS_PASSWORD` and `REDIS_URL` in `.env`.
3. Restart all services.

> **Production safety**: The Zod env validator rejects default dev secrets when `NODE_ENV=production`.

---

## 8. Database Operations

### Open Prisma Studio (GUI)

```bash
pnpm db:studio
```

### Run migrations

```bash
pnpm db:migrate
```

### Re-seed

```bash
pnpm db:seed
```

### Manual SQL (inside Docker)

```bash
docker exec -it cih_postgres psql -U cih_user -d channel_hub
```

### Backup

```bash
docker exec cih_postgres pg_dump -U cih_user channel_hub > backup_$(date +%Y%m%d).sql
```

---

## 9. Redis Inspection

### Redis Commander (GUI)

Navigate to **http://localhost:8081** when running `pnpm infra:up`.

### CLI

```bash
# Connect
docker exec -it cih_redis redis-cli -a "$REDIS_PASSWORD"

# View all circuit breaker keys
KEYS circuit:*

# View all BullMQ queues
KEYS bull:*

# Inspect a specific circuit
GET circuit:partner_a:state
GET circuit:partner_a:failures

# View distributed lock keys
KEYS inventory:*
```

---

## 10. Viewing Logs

### Development

```bash
pnpm dev:api    # streams NestJS logs with colour
```

### Docker Compose

```bash
# All services
pnpm stack:logs

# Specific service
docker compose -f docker-compose.full.yml logs -f api

# Infra only
pnpm infra:logs
```

### Key log prefixes to watch

| Logger name | What it reports |
|---|---|
| `WebhooksController` | Inbound webhook processing |
| `ReservationStateMachineService` | State transitions and idempotent no-ops |
| `InventoryService` | Booking / restore operations |
| `AvailabilityFanoutListener` | Fan-out event handling |
| `OutboundSyncProcessor` | Outbound push success / failure / DLQ |
| `CircuitBreakerService` | Circuit state changes |
| `ReconciliationService` | Drift detection results |
| `Bootstrap` | Startup, port binding, Swagger init |

---

## Quick Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Webhooks return 401 | Partner credentials mismatch | Check env var matches partner's config |
| Jobs stuck in FAILED | Partner API is down | Check circuit state → reset circuit → replay jobs |
| Circuit is OPEN but partner is back | Circuit hasn't probed yet | Force-reset: `POST /admin/partners/:slug/circuit/reset` |
| Availability not updating on partners | Fan-out listener crashed | Check API logs for `AvailabilityFanoutListener` errors |
| Drift log: MISSING_IN_CANONICAL_DB | Webhook was missed | Resolve with `ACCEPT_PARTNER` to ingest the booking |
| Health/ready returns 503 | Postgres or Redis is down | Check infra: `pnpm infra:logs` |
| Env validation fails at boot | Missing or invalid env var | Check error message — it lists the exact variable and constraint |

---

[⬅ Back to README](../README.md) · [Architecture & Diagrams](ARCHITECTURE.md) · [Adding a Partner](ADDING_A_PARTNER.md)

