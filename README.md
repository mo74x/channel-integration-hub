<p align="center">
  <h1 align="center">Channel Integration Hub</h1>
  <p align="center">
    Unified hospitality channel manager that normalises heterogeneous OTA / booking-engine APIs behind a single canonical data model.
  </p>
</p>

<p align="center">
  <a href="https://github.com/mo74x/channel-integration-hub/actions/workflows/ci.yml">
    <img src="https://github.com/mo74x/channel-integration-hub/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI Suite" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js" alt="Node ≥ 20" />
  <img src="https://img.shields.io/badge/pnpm-9.12-F69220?logo=pnpm" alt="pnpm 9.12" />
  <img src="https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs" alt="NestJS 10" />
  <img src="https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma" alt="Prisma ORM" />
  <img src="https://img.shields.io/badge/BullMQ-queues-DC382D?logo=redis" alt="BullMQ" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT" />
</p>

---

## Features

| Area | What it does |
|---|---|
| **Webhook Ingestion** | Receives partner webhooks, verifies authenticity (API-Key / OAuth2 / HMAC-SHA256), and normalises payloads into a canonical reservation schema. |
| **Adaptor Pattern** | A pluggable `PartnerAdaptor` interface — each partner gets its own driver (A = API-Key, B = OAuth2, C = HMAC, D = API-Key) with zero coupling between them. |
| **Inventory Calendar** | Per-unit, per-date availability and pricing with distributed Redis locks and optimistic-versioning to prevent overselling. |
| **Reservation State Machine** | Enforced `PENDING → CONFIRMED → CANCELLED / REJECTED` transitions with automatic inventory decrement / restore. |
| **Outbound Sync & Fan-out** | When availability changes, BullMQ fans out inventory pushes to every active partner, skipping the originator to prevent echo loops. |
| **Circuit Breaker** | Redis-backed three-state (CLOSED → OPEN → HALF_OPEN) breaker per partner — failures trip the circuit, a single probe request re-closes it. |
| **Dead-Letter Queue** | Failed outbound jobs move to `DEAD_LETTER` after exhausting retries (or on 4xx). Operators can replay them from the Admin API. |
| **Drift Reconciliation** | Pulls remote partner state, diffs against canonical DB, and logs drift (status mismatches, missing records). Operators can accept-partner / keep-canonical / dismiss. |
| **Schema Mapper (AI-assisted)** | `POST /admin/schema-mapper/propose/:slug` generates field-mapping suggestions for new partners. |
| **Admin Dashboard** | Next.js web UI for managing partners, viewing jobs, and resolving drift. |
| **Health Probes** | `/health/live` (k8s liveness) and `/health/ready` (Postgres + Redis readiness). |
| **Idempotency** | SHA-256 content-hash or partner-supplied key with DB-backed acquire / commit / rollback semantics. |
| **CI / CD** | GitHub Actions pipeline: lint → typecheck → unit tests (70 % coverage gate) → E2E (Postgres + Redis service containers) → Docker build & push to GHCR. |

---

## Quick Start

```bash
# 1. Clone & install
git clone https://github.com/mo74x/channel-integration-hub.git
cd channel-integration-hub && cp .env.example .env && pnpm install

# 2. Start infrastructure (Postgres 16, Redis 7, Redis Commander)
pnpm infra:up

# 3. Generate Prisma client, migrate & seed
pnpm db:generate && pnpm db:migrate && pnpm db:seed

# 4. Start the API (hot-reload) + mock partner stubs
pnpm dev:api          # → http://localhost:3000
pnpm dev:partners     # → http://localhost:4000

# 5. Run tests
pnpm test             # unit
pnpm test:e2e         # integration (needs infra running)
```

> **One-liner full stack** (Docker Compose — builds all images):
> ```bash
> cp .env.example .env && docker compose -f docker-compose.full.yml up -d --build
> ```
> API → `:3000` · Web dashboard → `:3001` · Mock partners → `:4000` · Redis Commander → `:8081`

**OpenAPI docs** are available at **http://localhost:3000/docs** once the API is running.

---

## Project Layout

```
channel-integration-hub/
├── apps/
│   ├── api/                          # NestJS API (core backend)
│   │   └── src/
│   │       ├── main.ts               # Bootstrap, Helmet, CORS, Swagger
│   │       ├── app.module.ts         # Root module wiring
│   │       ├── config/               # Zod env validation
│   │       ├── common/
│   │       │   ├── circuit-breaker/  # Redis-backed circuit breaker
│   │       │   ├── crypto/           # Timing-safe compare
│   │       │   ├── database/         # Prisma client re-export
│   │       │   ├── exceptions/       # Domain exceptions
│   │       │   ├── filters/          # Global exception filter
│   │       │   ├── guards/           # Admin API-key guard
│   │       │   ├── http/             # HTTP client with timeout
│   │       │   ├── idempotency/      # Idempotency service
│   │       │   ├── middleware/       # Request-ID middleware
│   │       │   └── redis/            # Redis module & distributed locks
│   │       └── modules/
│   │           ├── adaptors/         # PartnerAdaptor interface + drivers/
│   │           ├── admin/            # Admin CRUD + circuit reset + job replay
│   │           ├── health/           # Liveness & readiness probes
│   │           ├── inventory/        # Calendar CRUD + booking/restore
│   │           ├── reconciliation/   # Drift detection & resolution
│   │           ├── reservations/     # State machine + query service
│   │           ├── schema-mapper/    # AI-assisted field mapping
│   │           ├── sync/             # Outbound fan-out + BullMQ processors
│   │           └── webhooks/         # Inbound webhook controller
│   ├── mock-partners/                # Express stubs for Partners A-D
│   └── web/                          # Next.js admin dashboard
├── packages/
│   ├── database/                     # Prisma schema, migrations, seed
│   └── shared/                       # Canonical types, Zod schemas, enums
├── tests/
│   └── k6/                           # Load-testing scripts
├── docker-compose.yml                # Dev infra only (Postgres + Redis)
├── docker-compose.full.yml           # Full stack (infra + API + web + mocks)
├── .github/workflows/ci.yml          # CI pipeline
└── pnpm-workspace.yaml
```

---

## Script Reference

All scripts are runnable from the **workspace root**.

| Script | Description |
|---|---|
| `pnpm infra:up` | Start Postgres, Redis and Redis Commander (dev compose). |
| `pnpm infra:down` | Tear down dev infrastructure containers. |
| `pnpm infra:logs` | Tail dev infrastructure logs. |
| `pnpm stack:up` | Build and start the full stack (API + Web + Mocks + Infra). |
| `pnpm stack:down` | Tear down the full stack. |
| `pnpm stack:logs` | Tail full stack logs. |
| `pnpm db:generate` | Run `prisma generate` to create the Prisma Client. |
| `pnpm db:migrate` | Apply pending Prisma migrations. |
| `pnpm db:seed` | Seed the database with sample properties, units and partners. |
| `pnpm db:studio` | Open Prisma Studio (GUI database browser). |
| `pnpm build` | Build all packages and apps. |
| `pnpm dev:api` | Start the NestJS API in watch mode (`:3000`). |
| `pnpm dev:partners` | Start the mock partner server (`:4000`). |
| `pnpm test` | Run unit tests (Jest). |
| `pnpm test:cov` | Run unit tests with coverage (70 % line threshold). |
| `pnpm test:e2e` | Run end-to-end tests (requires infra). |
| `pnpm typecheck` | Typecheck all workspace packages. |
| `pnpm lint` | Check formatting with Prettier. |
| `pnpm format` | Auto-format all files with Prettier. |

---

## Environment Variables

Copy `.env.example` → `.env`. All variables have safe dev defaults.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` · `production` · `test` |
| `API_PORT` | `3000` | Port the NestJS API listens on. |
| `DATABASE_URL` | `postgresql://cih_user:…@localhost:5432/channel_hub?schema=public` | Postgres connection string. |
| `REDIS_HOST` | `localhost` | Redis hostname. |
| `REDIS_PORT` | `6379` | Redis port. |
| `REDIS_PASSWORD` | `redis_secure_password` | Redis password. |
| `ADMIN_API_KEY` | `cih_admin_secret_key_dev` | API key for admin endpoints (`x-admin-api-key` header). |
| `PARTNER_A_API_KEY` | dev key | Partner A bearer token. |
| `PARTNER_A_BASE_URL` | `http://localhost:4000/partner-a` | Partner A base URL. |
| `PARTNER_B_CLIENT_ID` | `client_b_channel_corp` | Partner B OAuth2 client ID. |
| `PARTNER_B_CLIENT_SECRET` | dev secret | Partner B OAuth2 client secret. |
| `PARTNER_B_BASE_URL` | `http://localhost:4000/partner-b` | Partner B base URL. |
| `PARTNER_C_HMAC_SECRET` | dev hex key | HMAC-SHA256 shared secret for Partner C webhooks. |
| `PARTNER_C_BASE_URL` | `http://localhost:4000/partner-c` | Partner C base URL. |
| `PARTNER_D_API_KEY` | dev key | Partner D API key. |
| `PARTNER_D_BASE_URL` | `http://localhost:4000/partner-d` | Partner D base URL. |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive failures before opening the circuit. |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | Milliseconds to wait before a half-open probe. |
| `CORS_ALLOWED_ORIGINS` | `localhost:3000,3001,4000` | Comma-separated allowed CORS origins. |
| `OPENAI_API_KEY` | *(optional)* | Enables AI-assisted schema mapping. |

> ⚠️ **Production safety** — the Zod env validator rejects default dev secrets when `NODE_ENV=production`.

---

## API Endpoints (Summary)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhooks/:partnerSlug` | Partner creds | Inbound reservation webhook |
| `GET` | `/inventory/:propertyId/availability?from=&to=` | — | Query availability calendar |
| `PUT` | `/inventory/:propertyId/units/:code/calendar` | — | Bulk-update calendar slots |
| `GET` | `/reservations` | — | List / filter reservations |
| `GET` | `/reservations/:id` | — | Get single reservation |
| `GET` | `/health/live` | — | Liveness probe |
| `GET` | `/health/ready` | — | Readiness probe (Postgres + Redis) |
| `GET` | `/admin/partners` | Admin key | All partners with circuit state |
| `PATCH` | `/admin/partners/:slug` | Admin key | Enable / disable partner |
| `POST` | `/admin/partners/:slug/circuit/reset` | Admin key | Force-reset circuit breaker |
| `GET` | `/admin/jobs?status=` | Admin key | List sync jobs |
| `POST` | `/admin/jobs/:id/replay` | Admin key | Replay a DLQ / failed job |
| `GET` | `/admin/reconciliation-logs` | Admin key | View drift logs |
| `POST` | `/admin/reconciliation-logs/:id/resolve` | Admin key | Resolve drift |
| `POST` | `/admin/reconcile/:partnerSlug` | Admin key | Trigger reconciliation sweep |
| `POST` | `/admin/schema-mapper/propose/:slug` | Admin key | AI schema-mapping proposal |
| `POST` | `/admin/schema-mapper/apply/:id` | Admin key | Apply mapping |

Full interactive OpenAPI / Swagger UI: **[http://localhost:3000/docs](http://localhost:3000/docs)**.
- **AdminApiKey**: Click *Authorize* and enter your `ADMIN_API_KEY` to test `/admin/*` management routes.
- **PartnerApiKey**: Enter the partner token to test `/webhooks/:partnerSlug` ingestion.

---

## Documentation Index

| Guide | Description |
|---|---|
| [📐 Architecture & Diagrams](docs/ARCHITECTURE.md) | Component architecture, webhook ingestion sequence, outbound sync & DLQ, reservation state machine, circuit breaker lifecycle, and ER diagram. |
| [🔌 Adding a Partner](docs/ADDING_A_PARTNER.md) | Step-by-step guide to writing a `PartnerAdaptor` driver with Partner D as the worked example, mock routes, seed config, and PR checklist. |
| [🛠️ Operations Runbook](docs/RUNBOOK.md) | Runbook for DLQ job replay, manual circuit breaker reset, drift resolution, secret rotation, Redis inspection, and troubleshooting. |

---

## License

MIT © Channel Integration Hub

