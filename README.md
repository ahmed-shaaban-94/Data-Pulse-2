# Data-Pulse-2

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-9.15.0-F69220.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6.svg)](tsconfig.base.json)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E.svg)](apps/api)

Data-Pulse-2 is the backend foundation for a multi-tenant SaaS platform. It
owns the API, worker runtime, database schema, shared contracts, and
cross-cutting platform primitives that future dashboard and POS experiences
will build on.

The repository is intentionally backend-first today. The dashboard UI is a
deferred feature, and POS applications live outside this repository.

![Data-Pulse-2 architecture](docs/assets/data-pulse-architecture.svg)

## Highlights

- Multi-tenant API foundation with tenant and store context switching.
- Contract-first OpenAPI 3.1 package used as the source of API truth.
- PostgreSQL 16 schema and explicit SQL migrations managed through Drizzle
  schema definitions and a migration CLI.
- BullMQ worker process for asynchronous email jobs, backed by Redis.
- Shared security and observability primitives: argon2id password hashing,
  token hashing, structured error envelopes, pino logging, OpenTelemetry setup,
  request IDs, Zod validation, and Helmet.
- Testable NestJS modules with Jest, Supertest, and Testcontainers coverage
  patterns.

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/api` | NestJS HTTP API with auth, active context, validation, logging, request IDs, exception envelopes, and OpenAPI loading. |
| `apps/worker` | NestJS standalone worker process for BullMQ-backed background jobs. |
| `packages/auth` | Shared password, token, session, and auth token primitives. |
| `packages/contracts` | OpenAPI 3.1 YAML contracts of record. |
| `packages/db` | Drizzle schema, SQL migrations, tenant helpers, and migration CLI. |
| `packages/shared` | Shared Zod, errors, logging, observability, IDs, and queue configuration. |
| `specs/001-foundation-auth-tenant-store` | Product, architecture, data model, and acceptance artifacts for the active foundation feature. |
| `docs` | GitHub-facing architecture and contributor documentation. |

## Architecture

Data-Pulse-2 is a pnpm workspace with two deployable apps and four internal
packages. The API owns synchronous HTTP behavior; workers own asynchronous
processing; PostgreSQL remains the system of record; Redis supports queues and
runtime coordination.

```mermaid
flowchart LR
  clients["Dashboard UI / API clients<br/>future dashboard feature"]
  pos["POS clients<br/>future external repo"]

  api["apps/api<br/>NestJS HTTP API"]
  worker["apps/worker<br/>NestJS worker runtime"]

  contracts["packages/contracts<br/>OpenAPI 3.1 YAML"]
  auth["packages/auth<br/>passwords, tokens, session types"]
  dbpkg["packages/db<br/>schema, migrations, tenant helpers"]
  shared["packages/shared<br/>logging, errors, zod, otel, queues"]

  postgres[("PostgreSQL 16<br/>system of record")]
  redis[("Redis 7<br/>BullMQ + runtime coordination")]

  clients --> api
  pos -. reserved contracts .-> api
  api --> contracts
  api --> auth
  api --> dbpkg
  api --> shared
  api --> postgres
  api --> redis
  api -- email jobs --> redis
  worker --> redis
  worker --> shared
  worker --> postgres
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map,
data flow, deployment shape, and boundaries.

## Tech Stack

- Runtime: Node.js 20, pnpm 9.15, TypeScript 5.6 strict mode.
- API: NestJS 11, Express platform, Helmet, cookie-parser, Zod validation.
- Data: PostgreSQL 16, Drizzle ORM schema, explicit SQL migrations, RLS-oriented
  tenant context helpers.
- Jobs: Redis 7, BullMQ.
- Observability: pino, OpenTelemetry SDK and HTTP/Postgres/Redis
  instrumentation.
- Testing: Jest, ts-jest, Supertest, Testcontainers PostgreSQL.

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

### Start local infrastructure

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

### Build, test, and lint

```bash
pnpm build
pnpm test
pnpm lint
```

### Run apps

```bash
pnpm --filter @data-pulse-2/api start
pnpm --filter @data-pulse-2/worker start
```

During development, package-level `start:dev` scripts compile in watch mode
where available.

## Development Workflow

1. Read [CLAUDE.md](CLAUDE.md) and the active spec before changing behavior.
2. Keep code inside the existing workspace boundaries: apps depend on packages;
   packages do not depend on apps.
3. Add or update tests with behavior changes, especially for tenant isolation,
   authz, migrations, and worker failure paths.
4. Run the narrowest useful verification locally, then the root commands before
   opening a PR.
5. Use the existing GitHub pull request template and fill out the Constitution
   Check for every change.

## Deployment Notes

- `apps/api` is the HTTP service and requires `DATABASE_URL`; production email
  job enqueueing requires `REDIS_URL`.
- `apps/worker` is a standalone Nest application context; production requires
  `REDIS_URL` so BullMQ workers can subscribe to queues.
- PostgreSQL is the source of truth. Redis-backed state must remain disposable.
- SQL migrations under `packages/db/drizzle` are versioned artifacts and should
  be reviewed with rollback and lock-duration risk in mind.
- The local Docker compose file is developer-only and is not a production
  deployment manifest.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md)
- [Foundation data model](specs/001-foundation-auth-tenant-store/data-model.md)
- [Pull request template](.github/pull_request_template.md)

## License

MIT. See [LICENSE](LICENSE).
