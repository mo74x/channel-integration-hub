# Architecture

> Visual guide to the Channel Integration Hub internals.
> All diagrams use [Mermaid](https://mermaid.js.org/) — GitHub and most modern editors render them natively.

[⬅ Back to README](../README.md) · [Adding a Partner](ADDING_A_PARTNER.md) · [Operations Runbook](RUNBOOK.md)

---

## 1. Component View

High-level overview of the workspace packages and how they relate:

```mermaid
graph TB
    subgraph "External"
        PA["Partner A<br/>(API-Key)"]
        PB["Partner B<br/>(OAuth2)"]
        PC["Partner C<br/>(HMAC-SHA256)"]
        PD["Partner D<br/>(API-Key)"]
        Browser["Operator Browser"]
    end

    subgraph "apps/web"
        Dashboard["Next.js Dashboard<br/>:3001"]
    end

    subgraph "apps/api"
        direction TB
        WebhookCtrl["WebhooksController<br/>POST /webhooks/:slug"]
        InvCtrl["InventoryController<br/>GET/PUT /inventory"]
        ResCtrl["ReservationsController<br/>GET /reservations"]
        AdminCtrl["AdminController<br/>/admin/*"]
        HealthCtrl["HealthController<br/>/health/live · /health/ready"]

        subgraph "Core Services"
            StateMachine["ReservationStateMachine"]
            InvService["InventoryService"]
            SyncService["SyncService"]
            FanoutListener["AvailabilityFanoutListener"]
            Reconciliation["ReconciliationService"]
            CircuitBreaker["CircuitBreakerService"]
            Idempotency["IdempotencyService"]
            SchemaMapper["SchemaMapperService"]
        end

        subgraph "Adaptor Layer"
            Registry["ADAPTOR_REGISTRY<br/>Map&lt;slug, PartnerAdaptor&gt;"]
            AdaptorA["PartnerAAdaptor"]
            AdaptorB["PartnerBAdaptor"]
            AdaptorC["PartnerCAdaptor"]
            AdaptorD["PartnerDAdaptor"]
        end

        subgraph "Queue Workers"
            OutboundProc["OutboundSyncProcessor"]
            PollingProc["PollingProcessor"]
        end
    end

    subgraph "Infrastructure"
        Postgres[("PostgreSQL 16")]
        Redis[("Redis 7<br/>(BullMQ + Locks + CB)")]
    end

    subgraph "apps/mock-partners"
        MockServer["Mock Partner Server<br/>:4000"]
    end

    PA & PB & PC & PD -->|"webhooks"| WebhookCtrl
    Browser --> Dashboard
    Dashboard -->|"REST API"| AdminCtrl & InvCtrl & ResCtrl

    WebhookCtrl --> Registry
    WebhookCtrl --> Idempotency
    WebhookCtrl --> StateMachine
    StateMachine --> InvService
    StateMachine -.->|"event: reservation.inventory-changed"| FanoutListener
    FanoutListener --> SyncService
    SyncService -->|"enqueue"| Redis
    Redis -->|"dequeue"| OutboundProc
    OutboundProc --> CircuitBreaker
    OutboundProc --> Registry
    Registry --> AdaptorA & AdaptorB & AdaptorC & AdaptorD
    AdaptorA -.->|"push"| PA
    AdaptorB -.->|"push"| PB
    AdaptorC -.->|"push"| PC
    AdaptorD -.->|"push"| PD

    AdminCtrl --> Reconciliation
    AdminCtrl --> CircuitBreaker
    Reconciliation --> Registry

    InvService --> Postgres
    StateMachine --> Postgres
    Idempotency --> Postgres
    SyncService --> Postgres
    CircuitBreaker --> Redis
    InvService --> Redis

    HealthCtrl --> Postgres
    HealthCtrl --> Redis

    AdaptorA & AdaptorB & AdaptorC & AdaptorD -.->|"dev only"| MockServer
```

---

## 2. Webhook Ingestion Sequence

What happens when a partner sends a booking webhook:

```mermaid
sequenceDiagram
    participant Partner
    participant WebhooksController
    participant AdaptorRegistry
    participant Adaptor
    participant IdempotencyService
    participant StateMachine
    participant InventoryService
    participant Postgres
    participant EventEmitter

    Partner->>+WebhooksController: POST /webhooks/:slug (raw body)
    WebhooksController->>AdaptorRegistry: get(partnerSlug)
    AdaptorRegistry-->>WebhooksController: PartnerAdaptor

    WebhooksController->>+Adaptor: verifyWebhook(headers, rawBody)
    Adaptor-->>-WebhooksController: {isValid, idempotencyKey, parsedBody}

    alt Validation failed
        WebhooksController-->>Partner: 401 Unauthorized
    end

    WebhooksController->>+IdempotencyService: acquireOrReplay(key, scope)
    alt Duplicate request
        IdempotencyService-->>WebhooksController: {isDuplicate: true, cachedResponse}
        WebhooksController-->>Partner: 200 OK (cached)
    end
    IdempotencyService-->>-WebhooksController: {isDuplicate: false}

    WebhooksController->>Postgres: find Partner by slug
    WebhooksController->>Postgres: resolve PropertyPartnerMapping
    WebhooksController->>+Adaptor: transformInboundReservation(payload)
    Adaptor-->>-WebhooksController: CanonicalReservationPayload

    WebhooksController->>WebhooksController: Zod validate against CanonicalReservationSchema

    WebhooksController->>+StateMachine: processTransition(request)
    StateMachine->>+InventoryService: bookInventoryUnits(...)
    InventoryService->>Postgres: $transaction (decrement calendar)
    InventoryService-->>-StateMachine: {success, totalPriceCents, inventoryUnitId}
    StateMachine->>Postgres: INSERT reservation
    StateMachine->>EventEmitter: emit("reservation.inventory-changed")
    StateMachine-->>-WebhooksController: reservation record

    WebhooksController->>IdempotencyService: commit(key, 200, response)
    WebhooksController-->>-Partner: 200 OK {acknowledged, reservationId, status}
```

---

## 3. Outbound Sync & Dead-Letter Queue Flow

After inventory changes, the fan-out pushes updates to every active partner:

```mermaid
sequenceDiagram
    participant EventEmitter
    participant FanoutListener
    participant SyncService
    participant Postgres
    participant BullMQ as "BullMQ (Redis)"
    participant OutboundProcessor
    participant CircuitBreaker
    participant Adaptor
    participant PartnerAPI

    EventEmitter->>+FanoutListener: "reservation.inventory-changed"
    FanoutListener->>Postgres: query calendar rows for stay window
    loop Each calendar date
        FanoutListener->>+SyncService: broadcastInventoryUpdate(payload, skipPartnerId)
        SyncService->>Postgres: find active partners (exclude originator)
        loop Each target partner
            SyncService->>Postgres: INSERT SyncJob (QUEUED)
            SyncService->>BullMQ: add("push-inventory-slot", data, {attempts:5, backoff:exp})
        end
        SyncService-->>-FanoutListener: done
    end
    FanoutListener-->>-EventEmitter: done

    BullMQ->>+OutboundProcessor: dequeue job
    OutboundProcessor->>+CircuitBreaker: canExecute(slug)

    alt Circuit OPEN
        CircuitBreaker-->>OutboundProcessor: false
        OutboundProcessor->>BullMQ: moveToDelayed(+10s)
        Note over OutboundProcessor: Preserves retry budget
    end
    CircuitBreaker-->>-OutboundProcessor: true

    OutboundProcessor->>Postgres: update SyncJob → PROCESSING
    OutboundProcessor->>+Adaptor: pushInventory(update)
    Adaptor->>+PartnerAPI: POST /inventory
    PartnerAPI-->>-Adaptor: 200 OK

    alt Success
        Adaptor-->>OutboundProcessor: {success: true}
        OutboundProcessor->>CircuitBreaker: recordSuccess(slug)
        OutboundProcessor->>Postgres: update SyncJob → COMPLETED
    end

    alt 4xx Client Error
        Adaptor-->>OutboundProcessor: throw 4xx
        OutboundProcessor->>Postgres: update SyncJob → DEAD_LETTER
        Note over OutboundProcessor: UnrecoverableError — no retry, no circuit trip
    end

    alt 5xx / Timeout
        Adaptor-->>OutboundProcessor: throw 5xx
        OutboundProcessor->>CircuitBreaker: recordFailure(slug)
        OutboundProcessor->>Postgres: update SyncJob → FAILED
        Note over OutboundProcessor: BullMQ retries with exponential backoff
    end

    OutboundProcessor-->>-BullMQ: done

    Note over BullMQ,Postgres: After exhausting retries → OnWorkerEvent("failed") → DEAD_LETTER
```

---

## 4. Reservation State Machine

Valid transitions and their side-effects on inventory:

```mermaid
stateDiagram-v2
    [*] --> PENDING : New booking\n(no inventory hold)

    PENDING --> CONFIRMED : confirm\n→ bookInventoryUnits()
    PENDING --> REJECTED : reject\n(no inventory change)
    PENDING --> CANCELLED : cancel\n(no inventory change)

    CONFIRMED --> CANCELLED : cancel\n→ restoreInventoryUnits()

    CANCELLED --> [*] : Terminal
    REJECTED --> [*] : Terminal
```

| From | To | Inventory Side-Effect |
|---|---|---|
| *(new)* | `PENDING` | None — no units reserved yet. |
| *(new)* | `CONFIRMED` | `bookInventoryUnits()` — decrements `availableUnits` across the stay window. |
| `PENDING` | `CONFIRMED` | `bookInventoryUnits()` — decrements calendar. |
| `PENDING` | `REJECTED` | None. |
| `PENDING` | `CANCELLED` | None. |
| `CONFIRMED` | `CANCELLED` | `restoreInventoryUnits()` — increments `availableUnits` back. |

> **Idempotency**: If a transition request targets the current state, the state machine returns the existing record without side-effects.

---

## 5. Circuit Breaker States

The per-partner circuit breaker prevents cascading failures when an external partner API is down:

```mermaid
stateDiagram-v2
    [*] --> CLOSED

    CLOSED --> OPEN : consecutiveFailures ≥ threshold\n(default 5)
    OPEN --> HALF_OPEN : cooldown elapsed\n(default 30 s)\nSingle probe via SET NX
    HALF_OPEN --> CLOSED : probe succeeds\n→ recordSuccess()
    HALF_OPEN --> OPEN : probe fails\n→ re-open immediately
    CLOSED --> CLOSED : recordSuccess()\n(reset counters)

    note right of OPEN
        All outbound calls fail-fast.
        Jobs are delayed, not retried,
        preserving their retry budget.
    end note
```

**Redis keys per partner:**

| Key | Purpose |
|---|---|
| `circuit:<slug>:state` | Current state (`CLOSED` / `OPEN` / `HALF_OPEN`) |
| `circuit:<slug>:failures` | Consecutive failure counter |
| `circuit:<slug>:opened_at` | Timestamp when circuit tripped to OPEN |
| `circuit:<slug>:probe_lock` | Atomic `SET NX` lock for the single half-open probe |

**Operator override**: `POST /admin/partners/:slug/circuit/reset` force-resets the circuit to `CLOSED` and clears all counters.

---

## Data Model (ER Diagram)

```mermaid
erDiagram
    Partner ||--o{ Reservation : "has"
    Partner ||--o{ SyncJob : "has"
    Partner ||--o{ ReconciliationLog : "has"
    Partner ||--o{ PropertyPartnerMapping : "mapped to"
    Property ||--o{ InventoryUnit : "contains"
    Property ||--o{ Reservation : "has"
    Property ||--o{ PropertyPartnerMapping : "mapped to"
    InventoryUnit ||--o{ InventoryCalendar : "has calendar"
    InventoryUnit ||--o{ Reservation : "booked as"

    Partner {
        uuid id PK
        string slug UK
        string name
        enum authType "API_KEY | OAUTH2 | HMAC_SIGNATURE"
        enum status "ACTIVE | DEGRADED | CIRCUIT_OPEN | DISABLED"
        json rateLimitConfig
    }

    Property {
        uuid id PK
        string name
        string timezone
        string currency
    }

    PropertyPartnerMapping {
        uuid id PK
        uuid propertyId FK
        uuid partnerId FK
        string externalPropertyId
        json fieldMapping
    }

    InventoryUnit {
        uuid id PK
        uuid propertyId FK
        string externalCode
        string name
        int totalUnits
    }

    InventoryCalendar {
        uuid id PK
        uuid inventoryUnitId FK
        date date
        int availableUnits
        int priceInCents
        int version "optimistic lock"
    }

    Reservation {
        uuid id PK
        uuid propertyId FK
        uuid inventoryUnitId FK
        uuid partnerId FK
        string externalBookingId
        enum status "PENDING | CONFIRMED | CANCELLED | REJECTED"
        date checkInDate
        date checkOutDate
        int unitsBooked
        string guestName
        int totalPriceCents
        int version
    }

    SyncJob {
        uuid id PK
        uuid partnerId FK
        enum jobType "INBOUND_WEBHOOK | OUTBOUND_PUSH | SCHEDULED_POLL"
        enum status "QUEUED | PROCESSING | COMPLETED | FAILED | DEAD_LETTER"
        int attempts
        int maxRetries
        json payload
    }

    ReconciliationLog {
        uuid id PK
        uuid partnerId FK
        string entityType
        string entityId
        json canonicalData
        json partnerData
        json driftDetail
        enum resolution "AUTO_CORRECTED | FLAGGED_FOR_REVIEW | DISMISSED"
    }

    IdempotencyRecord {
        string key PK
        string scope
        int responseStatus
        json responseBody
    }
```

---

[⬅ Back to README](../README.md) · [Adding a Partner](ADDING_A_PARTNER.md) · [Operations Runbook](RUNBOOK.md)

