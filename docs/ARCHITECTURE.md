# Data Pulse Architecture

Data Pulse is a backend-first TypeScript monorepo for a multi-tenant SaaS
foundation. The repository owns the API, worker runtime, contracts, database
schema, and shared platform primitives. Dashboard UI work is deferred to a
separate feature, and POS applications remain external repositories.

![Data Pulse architecture](assets/architecture-isometric.svg)

## Executive Summary

Data Pulse separates synchronous platform behavior from asynchronous processing.
`apps/api` handles authenticated HTTP requests, tenant/store context selection,
validation, logging, contract loading, and database access. `apps/worker`
handles background jobs through Redis and BullMQ. Internal packages hold the
shared contracts, database schema, auth primitives, and cross-cutting platform
utilities.

PostgreSQL is the durable source of truth. Redis is runtime coordination, never
domain truth. OpenAPI YAML in `packages/contracts/openapi` is the integration
contract of record.

## System Shape

```mermaid
flowchart TB
  subgraph clients["Clients and consumers"]
    dashboard["Dashboard UI<br/>future feature"]
    apiClients["API consumers"]
    pos["POS clients<br/>external repository"]
  end

  subgraph apps["Deployable apps"]
    api["apps/api<br/>NestJS HTTP API"]
    worker["apps/worker<br/>NestJS worker"]
  end

  subgraph packages["Workspace packages"]
    contracts["packages/contracts<br/>OpenAPI 3.1 YAML"]
    auth["packages/auth<br/>passwords, token hashes, auth types"]
    db["packages/db<br/>schema, migrations, tenant helpers"]
    shared["packages/shared<br/>zod, errors, logger, otel, queues"]
  end

  postgres[("PostgreSQL 16<br/>system of record")]
  redis[("Redis 7<br/>BullMQ coordination")]

  dashboard --> api
  apiClients --> api
  pos -. reserved authenticated contracts .-> api

  api --> contracts
  api --> auth
  api --> db
  api --> shared
  api --> postgres
  api --> redis

  api -- enqueue async jobs --> redis
  worker -- consume jobs --> redis
  worker --> shared
  worker -. future processors .-> postgres
```

## Runtime Responsibilities

| Runtime | Owns | Does not own |
| --- | --- | --- |
| `apps/api` | HTTP bootstrap, auth endpoints, active tenant/store context, validation, exception envelopes, request IDs, logging, OpenAPI contract loading, PostgreSQL access, queue production. | Background processing, dashboard UI, POS app code. |
| `apps/worker` | Standalone Nest application context, BullMQ worker factory, email queue consumption, provider-adapter seams, graceful shutdown. | HTTP routing, tenant context selection, frontend behavior. |
| PostgreSQL | Durable source of truth, constraints, migrations, tenant isolation policy support. | Cache semantics or queue delivery. |
| Redis | BullMQ transport and runtime coordination. | Durable domain truth. |

## Package Boundaries

```mermaid
flowchart LR
  api["apps/api"]
  worker["apps/worker"]
  auth["packages/auth"]
  contracts["packages/contracts"]
  db["packages/db"]
  shared["packages/shared"]

  api --> auth
  api --> contracts
  api --> db
  api --> shared
  worker --> shared

  auth -. no app imports .-> shared
  db -. no app imports .-> shared
```

Boundary rules:

- Apps may depend on packages.
- Packages must not import from `apps/*`.
- `apps/api` and `apps/worker` do not import from each other.
- OpenAPI YAML in `packages/contracts/openapi` is the contract source of truth.
- SQL migrations under `packages/db/drizzle` are versioned review artifacts.

## API Request Flow

```mermaid
sequenceDiagram
  participant Client
  participant API as apps/api
  participant Auth as AuthModule
  participant Context as ContextModule
  participant DB as PostgreSQL
  participant Queue as Redis/BullMQ

  Client->>API: HTTP request
  API->>API: assign request id, log, helmet, cookies
  API->>API: validate body and normalize exception envelope
  API->>Auth: validate session or token
  Auth->>DB: session/token lookup
  API->>Context: resolve tenant/store context
  Context->>DB: membership and store access lookup
  API->>DB: tenant-scoped read/write
  API-->>Queue: enqueue async email job when needed
  API-->>Client: response with request id
```

## Worker Flow

```mermaid
sequenceDiagram
  participant API as apps/api
  participant Redis as Redis/BullMQ
  participant Worker as apps/worker
  participant Adapter as EmailAdapter

  API->>Redis: add email job
  Worker->>Redis: subscribe to email queue
  Redis-->>Worker: deliver job
  Worker->>Worker: validate payload and apply defaults
  Worker->>Adapter: send or no-op through provider seam
  Worker-->>Redis: complete or fail job
```

## Data Model Themes

- Tenant, store, membership, role, permission, session, token, invitation,
  audit, and idempotency tables live in `packages/db/src/schema`.
- `packages/db/drizzle/0000_initial.sql` is the initial migration artifact.
- Tenant-scoped access should move through helpers such as `withTenant` and
  request DB context middleware rather than ad hoc SQL filtering.
- Cross-tenant and cross-store tests are required for behavior that touches
  tenant-owned data.

## Deployment View

```mermaid
flowchart LR
  apiContainer["API service<br/>node dist/main.js"]
  workerContainer["Worker service<br/>node dist/main.js"]
  pg[("Managed PostgreSQL 16")]
  redis[("Managed Redis 7")]
  logs["Logs and traces<br/>pino + OpenTelemetry"]

  apiContainer --> pg
  apiContainer --> redis
  workerContainer --> redis
  workerContainer -. future jobs .-> pg
  apiContainer --> logs
  workerContainer --> logs
```

Required production configuration:

- `DATABASE_URL` for API database access.
- `REDIS_URL` for production API email job enqueueing and worker queue
  consumption.
- `LOG_LEVEL` when the default `info` level is not appropriate.

## Current Gaps By Design

- Dashboard/web UI is not scaffolded in this foundation slice.
- POS endpoints are reserved by contract strategy but POS app code is out of
  scope here.
- Real email provider wiring is behind the worker adapter seam.
- Additional retail domain modules are staged through active specifications and
  task lists.
