# Retail Tower OS

[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-2563eb.svg)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-9.15.0-f59e0b.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.base.json)
[![NestJS](https://img.shields.io/badge/NestJS-11-e0234e.svg)](apps/api)

![Retail Tower OS — The command tower for modern retail](docs/assets/brand/exterior/retail-tower-os-exterior-hero.png)

> The command tower for modern retail. Control every branch from one secure core.

**Retail Tower OS** is the external product identity for this platform. The implementation
repository is `Data-Pulse-2` — the backend-first codename. No repository names, package names,
OpenAPI titles, or deployment configuration have been changed.

This image represents **product vision**. It does not imply that a dashboard frontend, POS
application, or production operations UI is implemented in this repository. The POS application
is a separate repository that integrates through the OpenAPI contracts in
`packages/contracts/openapi/`.

See [`docs/brand/retail-tower-os.md`](docs/brand/retail-tower-os.md) for the full brand
identity record, approved imagery, scope notes, and usage guidelines.

---

## What Retail Tower OS Controls

The platform that stands behind every branch — multi-tenant architecture, catalog authority,
POS connectivity, access control, and audit provenance unified under one secure operating core.

| Capability | Platform scope |
| --- | --- |
| <img src="docs/assets/brand/icons/branch-ops.svg" width="24" alt="Branch operations"> Branch operations | Multi-tenant isolation and store hierarchy managed from a single command core. |
| <img src="docs/assets/brand/icons/catalog.svg" width="24" alt="Catalog authority"> Catalog authority | Global product index propagated through tenant and store layers with store-level override. |
| <img src="docs/assets/brand/icons/store-network.svg" width="24" alt="Store network"> Store network | Connected branch context carried at every API, database, and job boundary. |
| <img src="docs/assets/brand/icons/access-control.svg" width="24" alt="Access control"> Access control | Role-based identity for operators and staff, scoped to tenant and store. |
| <img src="docs/assets/brand/icons/integrations.svg" width="24" alt="POS connectivity"> POS connectivity | The API gateway POS applications connect to through authenticated, versioned contracts. |
| <img src="docs/assets/brand/icons/audit-compliance.svg" width="24" alt="Audit provenance"> Audit provenance | Every mutation is traceable; sale facts are immutable once committed. |
| <img src="docs/assets/brand/icons/security.svg" width="24" alt="Secure core"> Secure core | Multi-layer security — tenant RLS, token auth, and audit trail — built in from the start. |

> This table describes **platform scope and product vision**, not a list of implemented UI
> features. The POS application is a separate repository. Dashboard UI is a separate future
> feature.

---

## Platform Guarantees

Retail data systems become expensive when tenant boundaries, store ownership, audit trails, and
POS integration contracts are treated as afterthoughts. This platform makes those rules explicit
from the start.

| Guarantee | What it enforces |
| --- | --- |
| <img src="docs/assets/icons/tenant-isolation.svg" width="24" alt="Tenant isolation"> Tenant isolation | Tenant and store context are first-class at the API, database, and test layers. |
| <img src="docs/assets/icons/contracts.svg" width="24" alt="Contracts"> Contract-first APIs | OpenAPI 3.1 contracts are the integration source of truth, not generated side effects. |
| <img src="docs/assets/icons/audit.svg" width="24" alt="Audit"> Auditability | Security-sensitive workflows preserve actor, tenant, operation, outcome, and correlation context. |
| <img src="docs/assets/icons/worker.svg" width="24" alt="Workers"> Worker-owned async jobs | Email, fanout, retries, and future scheduled work live outside request handlers. |
| <img src="docs/assets/icons/observability.svg" width="24" alt="Observability"> Operational visibility | Request IDs, structured logging, and OpenTelemetry primitives are built into the platform layer. |
| <img src="docs/assets/icons/database.svg" width="24" alt="Database"> Durable source of truth | PostgreSQL remains authoritative; Redis-backed state is disposable coordination. |

---

## Platform Shape

`Data-Pulse-2` is a pnpm workspace with two deployable services and four internal packages.
The API owns synchronous HTTP behavior; the worker owns asynchronous processing; PostgreSQL
owns durable state; Redis coordinates queues.

```mermaid
flowchart LR
  clients["Dashboard / API clients<br/>future consumers"]
  pos["POS clients<br/>external repo"]
  api["apps/api<br/>NestJS HTTP API"]
  worker["apps/worker<br/>NestJS worker"]
  contracts["packages/contracts<br/>OpenAPI 3.1"]
  auth["packages/auth<br/>passwords and tokens"]
  db["packages/db<br/>schema and migrations"]
  shared["packages/shared<br/>errors, logs, ids, queues"]
  pg[("PostgreSQL 16<br/>system of record")]
  redis[("Redis 7<br/>BullMQ coordination")]

  clients --> api
  pos -. authenticated contracts .-> api
  api --> contracts
  api --> auth
  api --> db
  api --> shared
  api --> pg
  api -- enqueue jobs --> redis
  worker -- consume jobs --> redis
  worker --> shared
```

---

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/api` | NestJS HTTP API with auth, active context, validation, request IDs, logging, exception envelopes, and OpenAPI loading. |
| `apps/worker` | Standalone NestJS worker runtime for BullMQ-backed background processing. |
| `packages/auth` | Password hashing, token hashing, session types, and auth primitives. |
| `packages/contracts` | OpenAPI 3.1 YAML contracts of record. |
| `packages/db` | Drizzle schema, explicit SQL migrations, tenant helpers, and migration CLI. |
| `packages/shared` | Shared Zod helpers, error envelopes, logging, observability, IDs, and queue configuration. |
| `specs/001-foundation-auth-tenant-store` | Active foundation feature artifacts: spec, plan, research, data model, contracts, quickstart, and tasks. |
| `specs/002-pos-operator-identity` | POS operator identity specification and contract-planning artifacts. Specification only — the POS application is a separate repository. |
| `docs` | Architecture, documentation index, and presentation assets. |

## What This Repo Owns

- Multi-tenant SaaS backend foundation.
- Admin/dashboard backend APIs and shared contracts.
- Worker runtime and queue integration patterns.
- PostgreSQL schema, migrations, and tenant helpers.
- Shared platform primitives for auth, observability, validation, and errors.

## What This Repo Does Not Own

- POS application code.
- Dashboard frontend implementation.
- Production infrastructure manifests beyond local development support.
- Legacy `Data-Pulse` code as source material. The legacy repo is reference
  only and must be re-specified before anything is rebuilt here.

---

## Tech Stack

| Layer | Stack |
| --- | --- |
| Runtime | Node.js 20 LTS, pnpm 9.15, TypeScript 5 strict mode |
| API | NestJS 11, Express platform, Helmet, cookie-parser, Zod validation |
| Data | PostgreSQL 16, Drizzle schema, explicit SQL migrations |
| Jobs | Redis 7, BullMQ |
| Observability | pino, OpenTelemetry SDK, HTTP/Postgres/Redis instrumentation |
| Testing | Jest, ts-jest, Supertest, Testcontainers PostgreSQL |

---

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- pnpm 9.15.0 or newer.
- Docker Desktop or another Docker-compatible runtime for local PostgreSQL and
  Redis.

### Install

```bash
pnpm install
```

### Start Local Infrastructure

```bash
pnpm db:up
```

The development compose stack exposes:

- PostgreSQL: `postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2`
- Redis: `redis://localhost:6379`

For local API and worker runs, set:

```bash
DATABASE_URL=postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2
REDIS_URL=redis://localhost:6379
```

### Build, Test, And Lint

```bash
pnpm build
pnpm test
pnpm lint
```

### Run Services

```bash
pnpm --filter @data-pulse-2/api start
pnpm --filter @data-pulse-2/worker start
```

During development, package-level `start:dev` scripts compile in watch mode
where available.

### Verify Startup

After starting the API, check the terminal output for a pino log line
confirming the server is listening (default port `3000`). No unauthenticated
health endpoint is exposed — a clean startup log is the expected signal. For
a full behavior walkthrough, see the
[foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md).

---

## Documentation

The [documentation index](docs/README.md) is the main hub, with audience-based
navigation for product, engineering, security, and integration reviewers.

Key references:

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Contracts package](packages/contracts/README.md)

---

## Development Agreement

This platform follows the active Constitution and Spec Kit workflow. Start from
the current spec, keep changes thin, preserve tenant isolation, and do not
change dependency manifests, lockfiles, SQL migrations, or database schema
without explicit approval.

---

## License

MIT. See [LICENSE](LICENSE).
