# Implementation Plan: Platform Production Readiness

**Feature ID**: 004
**Spec**: [spec.md](./spec.md) (clarified 2026-05-16)
**Research**: [research.md](./research.md)
**Constitution**: v3.0.0 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Branch**: `spec/003-catalog-foundation` (until merged; feature 004 lives alongside 003 work)
**Status**: Draft — planning artifacts only; **no implementation in this PR**
**Created**: 2026-05-16
**Owner**: Ahmed Shaaban
**Parallel-safe with**: 003-catalog-foundation

> **Scope guardrail**: This plan covers ONLY the five tracks defined in spec
> §6–§10 (Load Testing, Observability, Outbox, Idempotency, SDK Generation).
> It does NOT plan catalog implementation, POS implementation, dashboard UI,
> billing, reports, analytics, dbt, ClickHouse, Dagster, deployment
> infrastructure, or any other domain feature.
>
> Per spec §1, §3, and §20: **no runtime code**, **no DB schema**, **no
> migrations**, **no OpenAPI contract changes**, **no `package.json`**, **no
> `pnpm-lock.yaml`**, **no CI workflow changes**, **no generated files**, **no
> changes under `apps/**` or `packages/**`**. This planning PR is the
> deliverable; track-level implementation is gated behind explicit approval
> per §5 of this plan.

---

## 1. Summary

Feature 004 is the production-readiness planning artifact for Data-Pulse-2.
The platform has working multi-tenant primitives (auth, RLS, tenant/store
context, audit, BullMQ workers) from Feature 001 and a clarified catalog
source-of-truth model from Feature 003. Before the platform takes on real
retail load — catalog, inventory, sales, POS sync — five cross-cutting
capabilities must be **specified, agreed, and gated**:

| Track | Capability | First-slice deliverable (gated) |
|---|---|---|
| **A** | k6 load testing | External k6 scripts (no `package.json` change) exercising auth, tenant context, tenant/store reads, membership mutations, audit-heavy governance flows. |
| **B** | Vendor-neutral observability | Documented signal catalogue, redaction policy, cardinality discipline — implementation slice instruments **existing** endpoints only. |
| **C** | Transactional outbox | Future durable event recording with 90d/365d split retention; no schema in this feature. |
| **D** | HTTP idempotency middleware | Future NestJS interceptor wrapping the existing `IdempotencyKeyStore`; first endpoint chosen at approval time; **`425 Too Early`** for in-flight collisions. |
| **E** | OpenAPI SDK generation | Documented strategy only — `openapi-typescript` + `openapi-fetch` as directional default; **no `packages/sdk` in the first slice**; no generated files in this repo yet. |

This plan codifies *what* each track must achieve, *where* each crosses a
gating wall, *how* it stays parallel-safe with Feature 003, and *which*
research items must close before per-track implementation slices land.

This feature directly operationalizes Constitution §2 (tenant context safety
must be load-tested and observable), §3 (idempotent retries are part of data
integrity), §5 (async work in workers with tenant context established before
DB access), §7 (Observable Systems), §8 (Reproducible & Versioned Releases —
gated implementation slices), §11 (Idempotency & External IDs), and §14 (PII
redaction at the logger boundary).

---

## 2. Architecture fit

### 2.1 Stack inheritance from Foundation 001

This feature inherits the full TypeScript-first stack established in 001 and
reaffirmed in 003. No stack change is motivated by 004; all five tracks plug
into the existing surface.

| Concern | Inherited decision | How 004 uses it |
|---|---|---|
| Runtime | Node.js 20 LTS · TypeScript 5.x strict · pnpm workspaces | Track A scripts live *outside* the runtime; Tracks B–D extend existing modules; Track E generates artifacts external to the runtime. |
| API | NestJS 11 with `AuthGuard`, `TenantContextGuard`, `RolesGuard`, `RequestId`/`Logging`/`AuditEmitter` interceptors | Track B reuses the existing interceptor chain to emit signals. Track D adds a single new interceptor (future, gated). |
| Workers | BullMQ + `apps/worker` | Track C's drainer is a future BullMQ worker; Track B emits queue/worker signals from existing worker harness. |
| Database | PostgreSQL 16+ with RLS, Drizzle ORM, explicit SQL migrations | Track C's outbox table is a future migration (gated). Track D leverages the existing `idempotency_keys` Postgres mirror table (no new schema in 004). |
| Cache / Queue | Redis 7+ | Track D already uses Redis-primary via `IdempotencyKeyStore`. Track B emits Redis latency + BullMQ lag signals. |
| Validation | Zod 3.x `.strict()` at every boundary | Track D's interceptor wraps requests already validated upstream — fingerprint is computed from the validated body. |
| Observability runtime | pino structured logger + OpenTelemetry SDK + Prometheus exporter (per 001 plan) | Track B adds new *named* signals through existing exporters; no exporter rewrite. |
| Audit | `audit_events` + `AuditEmitter` + `audit-fanout` worker (from 001) | Track C uses this as the **first candidate outbox event source** for the narrow first slice (FR-C-007). |
| Idempotency primitive | `packages/shared/src/idempotency/store.ts::IdempotencyKeyStore` (already in repo) | Track D wraps this in an HTTP interceptor; **adds an in-progress marker layer** (future, gated) to support `425 Too Early`. |
| Contracts | OpenAPI 3.1 in `packages/contracts/openapi/` | Track E's source of truth; Track D adds per-endpoint idempotency policy declarations (future, gated). |

### 2.2 Where each track touches the architecture

| Track | New runtime surface | Existing surface reused | Cross-cutting impact |
|---|---|---|---|
| **A** Load testing | k6 scripts (out-of-tree) | Auth path, tenant/store context, RLS, queues — *as-is*. | Exercises the full guard chain under load; no app code change. |
| **B** Observability | Named metric/log/trace signals | OTel SDK, Prometheus exporter, pino logger, redaction wrapper, interceptors | Cuts across every endpoint and every worker; the redaction policy artifact is the single source of truth. |
| **C** Outbox | `outbox_events` table + drainer worker + consumer interface (all **future, gated**) | Drizzle migrations, BullMQ producer/consumer, tenant context helper | Replaces direct `queue.add(...)` calls inside DB transactions in flows that adopt it. |
| **D** Idempotency | `IdempotencyInterceptor` (NestJS, future, gated) + in-progress marker (Redis, future, gated) | `IdempotencyKeyStore` (already present), `(tenantId, storeId, clientId, key)` scoping | One endpoint at a time. Replay/conflict/`425`/expiry semantics documented per-endpoint in OpenAPI. |
| **E** SDK | Generated TypeScript types + fetch client | `packages/contracts/openapi/` source | First slice generates **outside this repo** or in a downstream repo; no `packages/sdk` introduced. |

### 2.3 Track independence

The five tracks are designed to be **independently shippable**:

- A test failure in Track A does not block Track B.
- Track B can ship signal names and the redaction policy artifact without
  Track C, D, or E being merged.
- Track C does not depend on Track D, and vice versa.
- Track E's research and direction can be locked while every other track is
  still gated.

There is **one** soft dependency: Track D's `425 Too Early` response code
should appear in Track E's generated client correctly. That's a Track E
contract-consumption concern, not a Track D scheduling concern.

---

## 3. Track-by-track implementation strategy

Every "implementation slice" below is **future work**, gated behind explicit
approval. Nothing in this section is authored in this PR.

### 3.1 Track A — Load Testing

**Strategy**: Lightest-possible first slice. External k6 scripts run by an
operator (or, eventually, by a separate ops-side runner) against a
non-production environment that mirrors production RLS / auth / tenant
context. **No** package dependency change, **no** CI integration, **no**
files under `apps/**` or `packages/**`.

#### 3.1.1 Execution model
- **Recommended**: external `k6 run` via the **k6 Docker image** (`grafana/k6`)
  invoked by an operator from their workstation or a dedicated runner host.
  Docker pin keeps the runtime reproducible without polluting the repo.
- Alternative: bare `k6` CLI binary installed on the operator's host. Same
  scripts; reproducibility shifts to the operator's environment.
- **Not** recommended for first slice: autocannon (Node-based), because it
  would pull in JavaScript runtime overhead for a load tool and tempt
  `package.json` adoption. See [research.md §1](./research.md).

#### 3.1.2 Test classes
Per spec §6.2:

| Class | First-slice scope | Pass/fail |
|---|---|---|
| Smoke | One auth + tenant-context flow at minimal RPS, ~30s | Must complete without errors |
| Baseline | Six candidate flows (§3.1.3) at expected production load, 5–15 min | p95/p99/error-rate thresholds (TBD per release) |
| Stress | Same flows, ramped to breakpoint, on-demand | Reports breakpoint; not a release gate |
| Regression | Replay of baseline against a stored prior baseline | Tracked-metric deltas within budget |

#### 3.1.3 Candidate endpoints (first-slice targets)

| # | Flow | Where it lives (existing in 001) | Why measure |
|---|---|---|---|
| 1 | `POST /api/v1/auth/signin` | Foundation auth | Establishes baseline auth latency under load. |
| 2 | `POST /api/v1/auth/refresh` | Foundation auth | Token refresh is the most common authenticated call. |
| 3 | `GET /api/v1/context/me` | Foundation tenant context | Tenant context establishment is on every authenticated request. |
| 4 | `GET /api/v1/tenants/{tenant_id}/members` | Foundation memberships | Tenant-scoped read with RLS. |
| 5 | `POST /api/v1/memberships/invite` + `POST /api/v1/invitations/accept` | Foundation membership mutations | Audit-heavy write path (also stresses audit fan-out). |
| 6 | `PATCH /api/v1/memberships/{membership_id}` (role/store-access update) and `DELETE /api/v1/memberships/{membership_id}` (revoke) | Foundation governance | Audit-heavy governance path. |

Catalog (003) endpoints are **excluded** from first-slice load tests per the
parallelism contract (§6) — they aren't implemented yet.

#### 3.1.4 Required measures (every run)
Per spec §6.4:

- HTTP: p50 / p95 / p99 latency; 4xx and 5xx rate (separated); RPS sustained
  + peak.
- DB: pool utilization; slow-query count; transaction-rollback rate.
- Redis: p50 / p95 latency.
- BullMQ: oldest waiting job age (queue lag) per queue exercised.
- Worker: p50 / p95 job duration per job type exercised.

Measures are emitted by Track B observability signals, **not** by k6 itself —
k6 reports HTTP-side numbers; the rest comes from the platform's own
metrics endpoint. This is one of the reasons Track B and Track A share a
first-slice rollout window (§8 thin slice 2 + 3).

#### 3.1.5 Data setup assumptions
- **Synthetic tenants only**: at least three tenants (`tenant-load-A/B/C`)
  with enough rows to make queries non-trivially expensive (membership,
  store, user counts representative of mid-tier customer profiles).
- **Synthetic stores**: per-tenant store counts mirroring real customer
  shapes (2, 8, 50 stores per tenant — see [research §7](./research.md)).
- **Tokens**: pre-provisioned long-lived test tokens scoped to load
  tenants only; never touch real customer tokens.
- **Network**: load runner sits in the same VPC/region as the API to avoid
  measuring last-mile latency.
- **Isolation**: load tests MUST run against a non-production environment;
  FR-A-007 forbids hitting production DB/Redis/queues.

#### 3.1.6 Environment boundaries

| Environment | Permitted | Notes |
|---|---|---|
| Local dev | Smoke only | Useful for harness debugging. |
| **Non-production load env** (mirrors prod RLS/auth/tenant context) | All four classes | The expected target for baseline + stress. |
| Production | **Forbidden** by FR-A-007 | Production is observed, not load-tested. |

Environment topology decision (single shared load env vs per-release ephemeral)
is a research item — see [research §7](./research.md).

### 3.2 Track B — Production Observability

**Strategy**: Define the signal catalogue and the redaction policy as
**documentation artifacts first**, then instrument existing endpoints / DB
calls / workers in a follow-up gated slice. Vendor selection (OTel Collector
vs Prometheus/Grafana vs managed) is deliberately deferred.

#### 3.2.1 Signal catalogue (documentation-only, this slice)

Per spec §7.3–§7.5:

| Layer | Signal | Type | Labels (low-cardinality only) |
|---|---|---|---|
| API | `http_request_count` | counter | `route`, `method`, `status_class` (2xx/3xx/4xx/5xx) |
| API | `http_request_duration_seconds` | histogram | `route`, `method` (p95 + p99) |
| API | `http_error_4xx_total` / `http_error_5xx_total` | counter | `route` |
| API | `auth_failure_total` | counter | `cause` (`bad_password`, `bad_token`, `expired`, `missing`, `rate_limited`) |
| API | `tenant_context_failure_total` | counter | `reason` (`missing`, `invalid`, `cross_tenant`) |
| API | `validation_failure_total` | counter | `route` |
| API | `suspicious_login_total` | counter | `reason` (`rapid_retry`, `geo_anomaly`) |
| API | `cross_tenant_rejection_total` | counter | `route` |
| API (Track D) | `idempotency_replay_total` | counter | `route` |
| API (Track D) | `idempotency_conflict_total` (409) | counter | `route` |
| API (Track D) | `idempotency_in_progress_total` (425) | counter | `route` |
| DB | `db_pool_in_use` / `db_pool_waiters` | gauge | (none) |
| DB | `db_slow_query_total` | counter | `query_class` (parameterized hash, no values) |
| DB | `db_rls_context_failure_total` | counter | (none — alertable, never per-tenant) |
| DB | `db_migration_status` | gauge | `state` (`pending`/`applied`/`failed`) |
| Redis | `redis_command_duration_seconds` | histogram | `command` (Redis verb; bounded set) |
| BullMQ | `queue_lag_seconds` | gauge | `queue` |
| BullMQ | `queue_failed_total` / `queue_dead_letter_total` | counter | `queue`, `error_class` |
| BullMQ | `queue_retry_total` | counter | `queue` |
| Worker | `worker_job_duration_seconds` | histogram | `job_name` (bounded set; one per declared job type) |
| Worker | `worker_processing_failure_total` | counter | `job_name`, `error_class` |
| Track C | `outbox_pending_total` / `outbox_dead_letter_total` | gauge / counter | `event_type` |
| Track C | `outbox_drain_duration_seconds` | histogram | `event_type` |

**Cardinality rule (FR-B-006, §7.7)**: `tenantId`, `storeId`, `userId`,
`actorId` are **never** metric labels. They live in **logs** and **traces**.

#### 3.2.2 Redaction policy (artifact location)

A single artifact — the **Redaction Matrix** — using the existing
`.specify/templates/redaction-matrix-template.md` template lives at:

```
.specify/memory/redaction-matrix.md
```

Lives there because it's a constitution-level invariant, not a feature-local
policy. (Discussion in [research §11](./research.md).) The matrix is the
single source of truth; every track's logger boundary defers to it.

Add-only by default (FR-B-005 / §7.6) — removing a redacted field requires
explicit audit and approval.

#### 3.2.3 Documentation targets for future dashboards / alerts

Future dashboards-as-code (Grafana JSON, OTel Collector pipelines) and
alerting rules live under:

```
docs/observability/   ← future location, NOT in this slice
   signals.md         ← catalogue index (Phase 1 deliverable)
   dashboards/        ← future, gated
   alerts/            ← future, gated
```

The first slice authors `signals.md` only. Dashboards-as-code and alerts
require their own gated PRs (no CI changes, no infra deploys here either).

#### 3.2.4 Vendor neutrality enforcement

- Every signal is named in **OTel-native semantic conventions** (e.g.,
  `http.server.duration` style or close approximations).
- Prometheus naming (`_total`, `_seconds`) is used **for documentation
  examples** but the *instrumentation* relies on the OTel SDK — the
  Prometheus exporter is one of several possible drains.
- No vendor-specific tag dimension (Datadog `dd.*`, New Relic `nr.*`,
  Honeycomb-only widely-cardinal fields) appears in any signal definition.

### 3.3 Track C — Outbox Pattern

**Strategy**: Specify the contract; *do not author* the schema, migration,
drainer worker, consumer interface, TTL indexes, or cleanup jobs. The first
gated implementation slice targets **a single narrow event type** — the
recommendation is `audit_events` fan-out, since it already exists and adopting
it as an outbox event source proves the contract on familiar ground without
catalog coupling.

#### 3.3.1 Durable event lifecycle (future contract)

```
APPLICATION              OUTBOX TABLE           DRAINER WORKER             CONSUMER
───────────              ─────────────          ──────────────             ────────
BEGIN TX
  state change          INSERT outbox_event
  (same tx)                                     polls / LISTEN-NOTIFY
COMMIT TX                                        → claim event
                                                 → publish to BullMQ
                                                                            establishes tenant ctx
                                                                            processes idempotently
                                                                            records processing
                                                 → mark delivered

                                                 OR on failure:
                                                  retry (bounded backoff)
                                                  exhaust budget → dead-letter
                                                                            (later) operator triage
```

State transitions on the outbox event: `pending → claimed → delivered`, or
`pending → claimed → failed → (retry)* → dead-lettered`.

#### 3.3.2 Tenant / store / correlation context (FR-C-002, §8.2.2)

Every outbox event carries:

| Field | Purpose | Set by |
|---|---|---|
| `event_id` | Stable dedup key | UUIDv7 at emission |
| `event_type` | Routes to consumer; drives retention class | Producer |
| `tenant_id` | Mandatory; drives RLS on the outbox table itself | Producer (server-resolved, never body-supplied) |
| `store_id` | Nullable; required for store-scoped events | Producer |
| `payload` | Event content; subject to redaction at log boundary | Producer |
| `correlation_id` | End-to-end trace identifier | Inherited from request or worker context |
| `occurred_at` | When the originating state change happened | Application clock at commit |
| `delivery_state` | `pending`/`claimed`/`delivered`/`failed`/`dead_lettered` | Drainer + consumer |
| `attempts` | Retry counter | Drainer |
| `last_error` | Last failure classification (no PII) | Drainer / consumer |

Workers consuming outbox events **MUST** establish tenant context via the
existing 001 helper before *any* DB access. This is Constitution §2 / §5
re-stated; FR-C-003 makes it auditable.

#### 3.3.3 Retry, poison, dead-letter

- Bounded exponential backoff (e.g., 30s, 2m, 10m, 1h — exact values are a
  per-event-type research item).
- Retry budget: 8 attempts default, overridable per event type.
- Exhaustion → `dead_lettered` state. **Never** silently dropped (FR-C-005).
- Dead-letter triage UX: operator-facing tool (admin endpoint vs CLI vs
  out-of-band) — see [research §10](./research.md).

#### 3.3.4 Retention (locked by Q2 / §1.5 of spec)

| Class | Window |
|---|---|
| `delivered` (processed successfully) | **90 days** from `processedAt` |
| `failed`, `dead_lettered`, `poison`, audit-relevant | **365 days** from latest state change |
| Any PII in `payload` | Right-to-erasure overrides both windows; payload redacted in place, event-occurred fact retained |

The 90/365-day windows are operational defaults; revisable only via spec
change, not ad-hoc per-event override (FR-C-004).

#### 3.3.5 Idempotent processing (FR-C-005, §8.2.5)

Consumers MUST treat `event_id` as the dedup key. Recommendation: a per-
consumer `processed_events` projection (consumer-side) recording
`(consumer_id, event_id)` with a unique constraint. Re-delivery is a no-op
after the first successful processing.

#### 3.3.6 Gating — all of the following require separate explicit approval

- `outbox_events` table creation (Drizzle schema + SQL migration).
- Drainer worker in `apps/worker`.
- Producer helpers in `packages/shared` or `packages/db`.
- TTL index / retention cleanup job.
- BullMQ queue creation for outbox events.
- Per-event-type retry budget config.

Per FR-C-006, the first implementation slice MUST target a single narrow
event type — recommendation `audit.event.created` (an existing audit event
re-emitted via outbox for a proof-of-life, **not** a new event class).

### 3.4 Track D — Idempotency Middleware

**Strategy**: Build the HTTP layer on top of the **existing**
`packages/shared/src/idempotency/store.ts::IdempotencyKeyStore` (already
present in repo: Redis-primary, Postgres-mirror, fingerprint-based collision
detection, TTL). Track D adds an HTTP interceptor + an in-progress marker
layer — both **future, gated**.

#### 3.4.1 What already exists in repo

`IdempotencyKeyStore` provides:

- `findOrCreate(tenantId, storeId, clientId, key, fingerprint)` returning
  `{hit: true, entry}` (replay), `{hit: "collision"}` (payload mismatch →
  409), or `{hit: false}` (first call).
- `save(tenantId, storeId, clientId, key, fingerprint, result, expiresAt?)`
  writing to Redis + Postgres mirror with a 24h default TTL.
- Storage schema: `packages/db/src/schema/idempotency_keys.ts` with
  columns `tenant_id, store_id, client_id, key, request_hash,
  response_status, response_body, expires_at`.

#### 3.4.2 Gaps Track D must close (all future, gated)

| Gap | What's missing | Where it lands (future slice) |
|---|---|---|
| **HTTP interceptor** | No NestJS middleware/interceptor wires `IdempotencyKeyStore` into request lifecycle | `apps/api/src/.../idempotency/idempotency.interceptor.ts` (future, gated) |
| **In-progress marker** | Store records *completed* results only; no marker for "request currently in flight" | Short-lived Redis key (`idempotency:inflight:...`) set at request start, deleted on response (future, gated) |
| **`425 Too Early` response** | No code path returns 425 today | The interceptor returns 425 when an in-progress marker exists for the same `(tenant, route, clientId, key)` (future, gated) |
| **`route` in scoping tuple** | Existing store uses `(tenant, store, client, key)`; spec mandates **route** as part of dedup tuple (FR-D-002) | The interceptor incorporates `route` into the `key` it passes to the store (e.g., `${method}:${route}:${clientKey}`) — no store schema change required (future, gated) |
| **Per-endpoint OpenAPI policy** | OpenAPI contracts don't yet declare per-endpoint idempotency policy | OpenAPI `x-idempotency: required\|optional\|na` extension per endpoint (future, gated; FR-D-008) |
| **Observability signals** | Replay/conflict/425 counters not emitted | Emit per §3.2.1 (future, gated; FR-D-010) |

#### 3.4.3 Interceptor flow (specification, not code)

```
Request lands at interceptor
  ↓
1. Endpoint in idempotency scope?
     no  → pass-through
     yes → continue
2. Idempotency-Key header present?
     no  → per-endpoint policy: 400 (required) OR pass-through (optional)
     yes → continue
3. Compute fingerprint = sha256(canonicalized validated body)
4. dedupKey = `${method}:${route}:${clientKey}`
5. Check in-progress marker for (tenantId, dedupKey)
     present → return 425 Too Early (FR-D-004, Q1)
              (response is non-blocking, no original-request data leaked,
               headers include Retry-After-style guidance)
     absent  → continue
6. store.findOrCreate(tenantId, storeId, clientId, dedupKey, fingerprint)
     hit: true       → replay stored response (status + body)
     hit: "collision"→ return 409 Conflict (FR-D-003)
     hit: false      → continue
7. Set in-progress marker (TTL = max expected request duration, e.g. 60s)
8. Call downstream handler
9. On success: store.save(...) AND delete in-progress marker
   On failure: delete in-progress marker; do NOT save (let client retry)
10. Emit idempotency_{replay|conflict|in_progress}_total counter
```

#### 3.4.4 In-progress marker design constraints

- **Non-blocking**: 425 returns immediately; never holds a server connection
  waiting on the original (FR-D-004).
- **Leak-proof**: the 425 body MUST NOT reveal which tenant/store/client
  owns the original request; use the standard uniform error envelope from
  Constitution §3.
- **TTL**: shorter than the replay-record TTL — must self-clean if a
  worker crashes mid-request. Recommendation: 60s default, configurable
  per-endpoint. See [research §3](./research.md).
- **Cross-tenant isolation**: marker key includes `tenantId` (FR-D-002). A
  different tenant with the same `Idempotency-Key` MUST NOT see a 425.

#### 3.4.5 Rollout — narrow, never global (FR-D-007, §9.3)

- **First slice endpoint**: `POST /api/v1/memberships/invite` (recommended;
  OpenAPI `operationId: createInvitation`).
  Reasons: retry-safe by design (creating an invitation is naturally
  idempotent if you have an external client key), low blast radius (no
  money, no inventory), already covered by 001 contract tests, and POS
  doesn't depend on it.
- Alternative first slice: `POST /api/v1/auth/refresh` — but tokens have
  their own retry semantics, so memberships is the cleaner choice.
- **Not** first slice: `POST /api/v1/auth/signin` (security-sensitive),
  audit-emitting governance routes (audit double-emission risk), any
  catalog/inventory/sales route (doesn't exist yet).
- Expansion to additional endpoints is per-endpoint and requires explicit
  approval (FR-D-007).

#### 3.4.6 Scoping tuple — divergence to resolve

| Source | Scoping tuple |
|---|---|
| Spec §9.2.4 | `(tenant, route, key)` for replay matching |
| Existing `IdempotencyKeyStore` | `(tenantId, storeId, clientId, key)` |

Reconciliation (locked in this plan): the **effective** dedup tuple at the
HTTP layer is `(tenantId, route, clientId, key)`, with `storeId` and
`payload_hash (fingerprint)` as comparison-only fields:

- `route` is baked into the `key` argument by the interceptor (not added as
  a new column).
- `clientId` is preserved from the existing store — useful for
  distinguishing two clients of the same tenant retrying with the same key.
- `storeId` is **not** in the dedup tuple; a request bound to one store
  retried with the same key but redirected to another store is treated as a
  collision (409) — which is the safe behavior. (Note for review:
  [research §2](./research.md) revisits whether `storeId` should be in the
  dedup tuple or comparison; default is "comparison-only" for now.)
- `payload_hash` is the collision detector, not part of the tuple.

This means **no schema change is required** for Track D's first slice —
the `key` column receives a composite string. That preserves SC-X-001 (zero
schema changes in this feature) and keeps the rollout thin.

### 3.5 Track E — OpenAPI SDK Generation

**Strategy**: Documentation-only in this feature. The directional default
(`openapi-typescript` + `openapi-fetch`, per Q3 / §1.5 of spec) is locked.
**No SDK files are generated**. **No `packages/sdk` is created in the first
slice.** The deliverable is the documented strategy plus the criteria under
which a future generation slice can be approved.

#### 3.5.1 Default direction (Q3, §10.3)

- **Types**: `openapi-typescript` (CLI) → strict TypeScript type definitions
  derived from `packages/contracts/openapi/`.
- **Client**: `openapi-fetch` → minimal typed `fetch` wrapper consuming the
  generated types. ~5kb minified; no runtime dependency beyond `fetch`.
- Rationale: TypeScript-native, no Java toolchain, tree-shakeable,
  minimum-viable client. See [research §5](./research.md).

#### 3.5.2 Candidate output locations

Per spec §10.4, the first-slice output location is **explicitly NOT
`packages/sdk`**:

| # | Location | First-slice eligibility | Status |
|---|---|---|---|
| 1 | **Outside this repo** (e.g., GitHub package registry, npm) | Eligible | Recommended when multiple external consumers exist. Requires a publishing target (no infra in this PR). |
| 2 | **Dashboard repo** (generated by the dashboard's own pipeline) | Eligible | Recommended for first slice if the dashboard repo exists and consumes contracts. |
| 3 | **POS repo** (generated by POS's own pipeline) | Eligible | Suitable when POS needs diverge from dashboard. |
| 4 | **Internal `packages/sdk`** in this monorepo | **NOT eligible for first slice** (FR-E-007) | Revisited only after dashboard/POS contract needs stabilize and after explicit approval for `package.json`/`pnpm-lock.yaml`/generated files. |

**Recommended first-slice location**: option 2 or 3 (downstream-repo
generation), so this repo remains the contract source of truth and no
generated artifacts land here.

#### 3.5.3 Drift detection

The OpenAPI contract is the source of truth (Constitution §IV). Drift
detection (FR-E-006) ensures the generated client matches the contract.

Three candidate mechanisms (research item — [research §6](./research.md)):

| Mechanism | Where it runs | Trade-off |
|---|---|---|
| Downstream-repo CI | In dashboard/POS repo CI | Each consumer owns its own drift gate; this repo stays clean. |
| Tag-based artifact | Each OpenAPI release publishes a tagged contract; consumers re-pin | No drift detection per se; relies on consumer discipline. |
| In-repo check (gated) | This repo's CI re-runs the generator and diffs | Requires CI workflow change → **gated**; not first-slice. |

Recommendation: **downstream-repo CI** for the first slice. Keeps this repo
unchanged. The in-repo check is a later optimization once `packages/sdk`
(or equivalent) is approved.

#### 3.5.4 Gating

- `package.json` / `pnpm-lock.yaml` change → **gated** (FR-E-007).
- New `packages/sdk` → **gated**, NOT first slice (FR-E-007).
- Generated `.ts` files inside this repo → **gated**.
- `openapi-typescript` / `openapi-fetch` as a dev dependency in this repo →
  **gated** (also blocks first slice).
- The OpenAPI contracts themselves remain editable through their normal
  contract-change process (Constitution §IV) — Track E does **not** gate
  them.

---

## 4. Non-blocking research decisions

Detailed analysis lives in [research.md](./research.md). Summary of
recommendations to lock during `/speckit-tasks` or the first per-track PR:

| # | Topic | Recommended direction | Status |
|---|---|---|---|
| 4.1 | Replay retention window | **72 hours** | Recommended in [research §2](./research.md) |
| 4.2 | First idempotency target endpoint | `POST /api/v1/memberships/invite` (OpenAPI `operationId: createInvitation`) | Recommended in [research §2](./research.md) |
| 4.3 | In-progress marker TTL | **60 seconds** default, per-endpoint override | Recommended in [research §3](./research.md) |
| 4.4 | First SDK output location | **Downstream repo (dashboard or POS)** — not `packages/sdk`, not this repo | Recommended in [research §5](./research.md) |
| 4.5 | Drift-detection mechanism | **Downstream-repo CI** for first slice; in-repo CI deferred | Recommended in [research §6](./research.md) |
| 4.6 | OpenTelemetry exporter target | **OpenTelemetry Collector (OTLP/gRPC)** + Prometheus scrape adapter; vendor-managed deferred | Recommended in [research §4](./research.md) |
| 4.7 | Slow-query threshold | **500ms** default, alert at sustained > 5/min over 5 min | Recommended in [research §4](./research.md) |
| 4.8 | Load environment topology | **Single shared non-production environment** with snapshot reset between runs | Recommended in [research §7](./research.md) |
| 4.9 | Regression delta budget | **+10% p95 / +20% p99 / +0.5pp error-rate** per tracked flow | Recommended in [research §1](./research.md) |
| 4.10 | Dead-letter triage UX | **Admin endpoint behind RolesGuard** with operator-only role; CLI deferred | Recommended in [research §8](./research.md) |
| 4.11 | Redaction-policy artifact location | **`.specify/memory/redaction-matrix.md`** using existing template | Recommended in [research §11](./research.md) |

These are *recommendations* — final selection per item happens at the
relevant per-track first-slice PR, where empirical evidence is available.
None of them block `/speckit-tasks`.

---

## 5. Gating model

Anything in the left column requires the gate in the right column. This is
the single canonical table for the feature.

| Touched artifact | Gate | Where in spec | Cleared by |
|---|---|---|---|
| `package.json` | **Explicit approval PR** | FR-A-011, FR-A-012, FR-E-007, §3.1 of spec | Owner sign-off, dependency review |
| `pnpm-lock.yaml` | **Explicit approval PR** | Same as `package.json` | Same |
| DB schema (Drizzle schema files) | **Explicit approval PR** | §3.1 of spec, FR-C-006 | Owner sign-off; migration-safety checklist; cross-tenant + cross-store sweep tests added in same PR |
| SQL migrations | **Explicit approval PR** | §3.1 of spec, FR-C-006 | Same as DB schema |
| OpenAPI contracts (`packages/contracts/openapi/**`) | **Explicit approval PR** | §3.1 of spec, FR-D-008 (adds `x-idempotency`); FR-E-001 (drives Track E) | Owner sign-off; contract test fixture update in same PR |
| CI workflow changes | **Explicit approval PR** | §3.1 of spec | Owner sign-off |
| Generated files (e.g., generated TypeScript clients) inside this repo | **Explicit approval PR** | FR-E-007 | Owner sign-off; drift-detection mechanism committed in the same PR |
| Source code under `apps/**` | **Explicit approval PR per track** | §3.1 of spec; FR-A-012, FR-B-001..003, FR-C-006, FR-D-001, FR-E-002 | Track-specific test plan; reviewer obligation per §5.4 |
| Source code under `packages/**` | **Explicit approval PR per track** | Same as `apps/**` | Same |
| New `packages/sdk` | **Explicit approval PR** + **NOT first slice** | FR-E-007 | Stable downstream consumer demand; multi-repo audit before adoption |
| `outbox_events` table | **Explicit approval PR** (gated under DB schema) | FR-C-006 | First narrow event type pilot must precede broad adoption |
| Idempotency interceptor | **Explicit approval PR** | FR-D-001 | One endpoint at a time (FR-D-007); per-endpoint OpenAPI policy added |
| k6 scripts | **Explicit approval PR**; first slice lives **outside `apps/**` / `packages/**`** | FR-A-005, FR-A-011 | No `package.json` change; synthetic-tenant assumptions documented |
| Redaction matrix artifact | **Explicit approval PR** (lives in `.specify/memory/`) | FR-B-011 | Constitution-level review |

Reviewer obligation (spec §5.4): every PR claiming to land a slice of
feature 004 MUST be checked against this table before approval. A PR that
violates it fails review regardless of code quality.

---

## 6. Parallelism with catalog (003)

This feature is designed to ship in parallel with 003-catalog-foundation
planning and its eventual implementation, subject to the spec's §5 hard
constraints:

### 6.1 Hard constraints (from spec §5.1)
- MUST NOT change any catalog schema (Global Product Index, Tenant
  Catalog, Store Override, Product Alias, Price History, Unknown Item
  Workflow, future SaleLine Snapshot).
- MUST NOT modify any catalog OpenAPI contract.
- MUST NOT introduce any catalog implementation code.
- MUST NOT define catalog-specific outbox event types, catalog-specific
  load scenarios depending on unbuilt catalog tables, or catalog-specific
  idempotency keys.
- MUST NOT introduce a dependency that forces 003 to ship before any
  track of 004 can ship.

### 6.2 Permitted parallel work (from spec §5.2)
- MAY define **future expectations** that catalog implementation can
  adopt (idempotency contract, outbox contract, observability signals).
- MAY enumerate catalog flows as **candidate** load-test targets for a
  *future* expansion (not first-slice).
- MAY use foundation endpoints (auth, tenant context, memberships, audit)
  as first concrete subjects for any pilot.

### 6.3 Conflict resolution (from spec §5.3)
If, during 004 implementation, a slice would force a change to catalog
schema or catalog contracts, that slice MUST be paused and re-scoped, or
deferred until after the relevant catalog feature lands. Production-readiness
work MUST NOT become a back door for catalog changes.

### 6.4 Reviewer obligation (from spec §5.4)
Every PR claiming a slice of feature 004 MUST be checked against §5.1 of the
spec by the reviewer, before approval.

### 6.5 Catalog's permitted adoptions
Once catalog implementation begins, it MAY adopt:

- Track B observability signals (with new catalog-specific signal names that
  follow the same naming + cardinality + redaction rules).
- Track D idempotency on its own mutating endpoints (one at a time, per the
  rollout discipline).
- Track C outbox for catalog domain events — **after** the outbox first slice
  has shipped with `audit.event.created` as the proof-of-life.
- Track A load tests for catalog flows — added by catalog's own feature.

If catalog tries to adopt any of these **before** that track's first slice
ships, catalog MUST emit/handle the equivalent directly (e.g., direct
`queue.add(...)` in lieu of outbox) and migrate later — per edge case §12.9
of the spec.

---

## 7. Test strategy

Every track has its own test obligations, layered consistently with
Constitution §VI (test-first, ≥80% coverage, Testcontainers for tenant
isolation, cross-tenant + cross-store sweep tests, RLS bypass probe). These
tests are **future** — they belong to the per-track first-slice PRs, not to
this planning PR.

### 7.1 Track A — Load test validation
- **Harness smoke test**: every PR that touches load scripts runs the smoke
  class first; failure blocks merge.
- **Synthetic data fixture tests**: verify load tenants/stores exist with
  expected row counts before any baseline run.
- **Auth path test**: scripts exercise `AuthGuard` / `TenantContextGuard` /
  `RolesGuard` end-to-end — never `setBypass(true)` or equivalent.
- **Cross-tenant concurrency test**: at least one baseline run uses ≥3
  tenants concurrently (FR-A-009) and verifies no tenant sees another's
  data in logs/responses.

### 7.2 Track B — Observability signal tests
- **Signal-presence test**: for each signal in §3.2.1, an integration test
  asserts the signal is exposed (e.g., scraping `/metrics` returns the
  named metric).
- **Cardinality test**: a static check (script + Prometheus metadata) asserts
  no signal has `tenant_id` / `store_id` / `user_id` / `actor_id` labels.
- **Redaction tests**: a fixture endpoint returns a body containing seeded
  PII (`pii-canary@example.test`); an integration test asserts the canary
  string never appears in pino output or in metric labels.
- **RLS context failure test**: a test crafts a DB call without tenant
  context and asserts `db_rls_context_failure_total` increments and the
  failure is logged at WARN/ERROR with redaction honored.
- **Cross-tenant rejection signal test**: a test triggers a cross-tenant
  attempt (per 001 RLS bypass probe) and asserts
  `cross_tenant_rejection_total` increments.

### 7.3 Track C — Outbox repository / processor tests
*(Future, in the gated outbox first slice — not this PR.)*

- **Repository tests**: insert/claim/mark-delivered/dead-letter happy paths
  + concurrent-drainer race condition (`FOR UPDATE SKIP LOCKED` semantics).
- **Tenant context test**: consumer fails RLS if it accesses DB before
  establishing tenant context.
- **Retry budget test**: failed event reaches dead-letter after N attempts;
  N+1th claim never happens.
- **Idempotent processing test**: re-delivering a `delivered` event
  produces no duplicate side effect; consumer-side `processed_events`
  uniqueness constraint enforces it.
- **Retention test**: events past 90d (delivered) / 365d (failed) are
  eligible for purge; PII erasure overrides both windows.
- **Redaction test**: outbox payloads containing PII never appear in full in
  pino output.

### 7.4 Track D — Idempotency replay / conflict / cross-tenant tests
*(Future, in the gated idempotency first slice — not this PR.)*

- **Replay test**: same `(tenant, route, clientId, key)` + same body →
  same response, same status, no second side effect.
- **Conflict test**: same `(tenant, route, clientId, key)` + different body
  → 409 Conflict; original response preserved.
- **`425 Too Early` test**: parallel duplicate request to same
  `(tenant, route, clientId, key)` while original is in flight → 425;
  response body MUST NOT leak original-request data; second request
  retried after original completes → replays (or processes as new if
  original failed).
- **Cross-tenant non-collision test**: tenant A's key X and tenant B's
  key X on the same route → both processed independently; no replay.
- **Expiry test**: key past retention window → treated as new request.
- **Missing-header policy test**: per-endpoint OpenAPI declaration
  honored — 400 if required and missing, pass-through if optional.
- **Observability test**: replay/conflict/425 counters increment per the
  Track B signal catalogue.

### 7.5 Track E — SDK generation / drift tests
*(Future, in the downstream consumer's first slice — not this PR.)*

- **Generator-run test**: running the generator against the current
  OpenAPI source produces a deterministic artifact (within a tolerated
  formatter delta).
- **Drift test**: re-running the generator and diffing against the last
  committed artifact yields an empty diff; non-empty diff fails CI in
  the downstream consumer.
- **Type-shape test**: a smoke test in the downstream consumer imports
  the typed client and calls one read endpoint; compile-time success is
  the assertion.
- **Idempotency support test**: the generated client correctly attaches
  `Idempotency-Key` headers and surfaces `425 Too Early` as a retryable
  result type, not a terminal error.

---

## 8. Rollout strategy

Thin slices, in order. Each slice is a separate PR; each clears its own
gate per §5. Nothing in slice N+1 can land before slice N is merged.

| # | Slice | Touches | Gates cleared | Estimated PR size |
|---|---|---|---|---|
| 1 | **This planning PR** — `spec.md`, `plan.md`, `research.md`, checklist | `specs/004-platform-production-readiness/**` only | None (no gates needed — planning artifact) | ~1,500 lines docs |
| 2 | **k6 first slice** (Track A) — synthetic-tenant fixture + smoke + baseline scripts | Repo location outside `apps/**` and `packages/**` (e.g., `loadtests/k6/`) | No `package.json`; no CI; no source | ~400 lines k6 JS + README |
| 3 | **Observability docs + redaction matrix** (Track B docs) — `signals.md`, `redaction-matrix.md` | `.specify/memory/redaction-matrix.md` + `docs/observability/signals.md` | No code; no signal instrumentation yet | ~600 lines docs |
| 4 | **Observability instrumentation** (Track B code) — add named signals + redaction wrappers to existing endpoints | `apps/api/**`, `apps/worker/**` (limited to interceptors / logger boundary / metric registration) | Source code under `apps/**` — explicit approval | ~800 lines TS + tests |
| 5 | **Idempotency design + tests for one endpoint** (Track D) — interceptor + in-progress marker + first endpoint contract test | `apps/api/**` (interceptor module); `packages/contracts/openapi/` (`x-idempotency: required` on one endpoint) | Source under `apps/**`; OpenAPI contract change | ~600 lines TS + tests + 1 contract edit |
| 6 | **Outbox design validation** (Track C) — RFC + spike branch + repository contract tests against a transient DB; no migration merged to main | Spike on a branch only | Schema/migration gated; this slice produces the test design + measured numbers | RFC PR ~400 lines |
| 7 | **Outbox first slice** (Track C) — `audit.event.created` via outbox | DB schema + migration; producer helper; drainer worker; observability signals | All gates per §5 | ~1,000+ lines (largest slice) |
| 8 | **SDK research close-out** (Track E) — final research lock + downstream-repo handoff doc | `specs/004-platform-production-readiness/research.md` update + new doc in dashboard/POS repo's onboarding | No code in this repo | ~200 lines docs |
| 9 | **SDK generation in downstream repo** (Track E execution) — happens **outside** this repo | n/a (downstream repo) | n/a from this repo's perspective | n/a |
| 10 | **Idempotency expansion** (Track D) — second endpoint, then third | `apps/api/**` + per-endpoint OpenAPI policy | Per-endpoint explicit approval | ~200 lines per endpoint |

Slices 2–3 can run in parallel; everything else is sequential within its
own track, parallel across tracks. Slice 7 is the largest and represents
the actual outbox going live; it should not land in the same release
window as a major catalog implementation slice (per §6.3).

---

## 9. Constitution check

Against constitution v3.0.0. Feature 004 **operationalizes** principles that
were either reaffirmed in 001 / 003 or that were marked as future obligations.

| Principle | Plan-level alignment | Status |
|---|---|---|
| **I. Reference, Not Source of Truth** | Plan introduces no legacy Data-Pulse pattern. Track B signals follow OTel-native conventions; Track C outbox follows standard transactional-outbox literature, not legacy code. | ✅ |
| **II. Multi-Tenant SaaS by Default** | Track A explicitly exercises cross-tenant RLS isolation (FR-A-009). Track B has a discrete `db_rls_context_failure_total` signal + a `cross_tenant_rejection_total` signal (FR-B-008/B-009). Track C consumers MUST establish tenant context before DB access (FR-C-003). Track D scopes idempotency keys per tenant (FR-D-002) and the `425` response MUST NOT leak cross-tenant info. | ✅ |
| **III. Backend Authority & Data Integrity (NON-NEGOTIABLE)** | Track D is the HTTP-layer operationalization of integrity-preserving retries. Track C is the integrity-preserving event emission contract. Replay/conflict/`425` semantics all preserve the uniform error envelope. POS totals (Track A baseline catalog work, future) preserved as received — no rewriting. | ✅ |
| **IV. Contract-First POS Integration** | Track E is wholly about generating typed clients from `packages/contracts/openapi/` as the source of truth. Track D adds per-endpoint `x-idempotency` policy declarations in OpenAPI — extending, not replacing, the contract. No raw DB entities in any future response. | ✅ |
| **V. Async Work Belongs in Workers** | Track C's outbox drainer is a BullMQ worker; consumers establish tenant context before DB access. Track B emits queue lag / failed jobs / dead-letter / retry / job-duration / worker-failure signals. Failed-job logs are redacted (FR-C-008). | ✅ |
| **VI. Test-First Quality** | Every track's test obligations (§7) are *defined before* any per-track implementation slice. Cross-tenant + cross-store sweep tests required for Track D (FR-D-002). RLS bypass probe is part of Track B signal-presence tests. Testcontainers required for Track C repository tests. | ✅ |
| **VII. Observable Systems** | Track B *is* the operationalization of §VII. The signal catalogue (§3.2.1) covers queue lag, RLS context failures, duplicate-event rate (via outbox), reconciliation mismatch rate (deferred to future feature). No secrets/tokens/PII in logs (FR-B-005, §7.6, redaction matrix). | ✅ |
| **VIII. Reproducible & Versioned Releases** | All five tracks have explicit gates against `package.json` / `pnpm-lock.yaml` / DB schema / SQL migration changes (§5). The gating table is the single canonical source. | ✅ |
| **IX. Source-of-Truth Model** | Feature 004 introduces **no** new source of truth — it observes, retries, and surfaces existing truths. Track C outbox preserves the existing audit pipeline's source-of-truth invariants (insert-only at application layer; FR-C-008 forbids full-payload logging that could be mistaken for an audit record). | ✅ |
| **X. Retail Temporal Semantics** | Track C outbox events carry `occurred_at` from the transaction commit. Track D replay records preserve the original response's headers semantically. Track B distinguishes `request_received_at` vs `response_emitted_at` in traces. Past sale facts are never rewritten by retries or replays. | ✅ |
| **XI. Idempotency & External IDs** | Track D *is* the operationalization of §XI for HTTP retries. Track C consumers are idempotent (FR-C-005); `event_id` is the dedup key. Workers and notification jobs (via outbox) are idempotent. POS ingestion (`sourceSystem + externalId`, future) inherits both contracts. | ✅ |
| **XII. Authorization & Object Safety** | Track D idempotency MUST NOT change authorization (FR-D-009): a replayed response was authorized when it was originally issued; a new authorization decision is not reused across requests. Track B signals never leak object IDs (cardinality discipline). Body-supplied `tenant_id` / `store_id` / `actor_id` / `Idempotency-Key` are validated; the tuple is server-resolved. | ✅ |
| **XIII. Auditability & Provenance** | Track C's first event is `audit.event.created` from the existing audit pipeline — provenance preserved (actor / tenant / store / operation / target / timestamp / correlationId / outcome). Track B logs include `correlation_id` end-to-end (FR-B-004). Track D replay records preserve original `actor_id` in the response, never the retry-er's. | ✅ |
| **XIV. PII & Data Lifecycle Discipline** | Redaction matrix lives at `.specify/memory/redaction-matrix.md` (single source of truth, FR-B-011, add-only by default). Outbox retention windows (90d/365d) explicitly defer to PII erasure — payload redacted in place, event-occurred fact preserved (FR-C-004, §12.12). Idempotency replay bodies containing PII subject to PII lifecycle (FR-D-006). | ✅ |

**Result**: No gate violations. All track-level designs respect every
constitutional principle. No `Justification` rows needed.

---

## 10. Risks (mirrored from spec §18, with planning-side mitigation)

| # | Risk | Planning mitigation |
|---|---|---|
| R-001 | Track B redaction policy drift | Redaction matrix as a single artifact (`.specify/memory/redaction-matrix.md`); add-only default; FR-B-011 + §3.2.2 of plan. |
| R-002 | Clients misinterpret `425 Too Early` as terminal | OpenAPI policy declares 425 as retryable; generated client (Track E) surfaces it as a retryable type, not a terminal error; documented in plan §3.4.4 + research §3. |
| R-003 | Track C outbox adopted too broadly too fast | FR-C-007 narrow-first slice (`audit.event.created`); plan §3.3.6 + rollout slice 6 (validation) before slice 7 (first event). |
| R-004 | Track E generator choice (`openapi-typescript` + `openapi-fetch`) becomes unmaintained | Drift detection (FR-E-006) makes regeneration cheap; directional default is revisable per FR-E-003 + research §5; downstream-repo CI mechanism (research §6) decouples this repo from generator lifecycle. |
| R-005 | Load tests produce flattering numbers against trivial data | Synthetic tenant fixtures with realistic row counts (plan §3.1.5); FR-A-009 enforces multi-tenant concurrency. |
| R-006 | Cardinality explosion from per-tenant metric labels | FR-B-006 + plan §3.2.1 cardinality rule: `tenant_id` / `store_id` / `user_id` are **never** metric labels. |
| R-007 | Production-readiness work accidentally couples to catalog schema | Plan §6 parallelism contract + §5.4 reviewer obligation; plan §3.4.5 explicitly recommends a foundation endpoint (not a catalog endpoint) for the first idempotency slice. |
| R-008 | Outbox retention windows (90d/365d) collide with future data-retention policy | §3.3.4 explicitly defers to such a policy; FR-C-004 makes windows revisable only via spec change. |
| R-009 | First-slice pressure to introduce `packages/sdk` | §5 gating table; reviewer obligation; recommendation in §3.5.2 to use downstream-repo generation; rollout slice 9 happens **outside this repo**. |

---

## 11. Open questions remaining after planning

All three **blocking** clarifications (Q1/Q2/Q3) are resolved in the spec's
§1.5. The non-blocking research items in spec §15.2 are addressed with
recommendations in §4 of this plan and detailed in `research.md`. None block
`/speckit-tasks`.

The only items left for resolution at the per-track first-slice PR (not at
`/speckit-tasks`):

- The empirical baseline numbers for Track A's pass/fail gating (p95/p99/
  error-rate thresholds per flow) — these require a first run against a
  realistic load env, which is itself a research deliverable in slice 2.
- The exact slow-query threshold value for Track B — recommended **500ms**
  but final calibration happens after the first observability instrumentation
  slice (slice 4) emits data.

Neither blocks task generation; both are reviewer-visible at the relevant
slice PR.

---

## 12. Phase summary

| Phase | Status | Output |
|---|---|---|
| Phase 0 — Research | Complete (this PR) | [research.md](./research.md) |
| Phase 1 — Design & contracts | **N/A by design** — no `data-model.md`, no `contracts/*.yaml`, no `quickstart.md`. This feature is planning-only across five gated tracks; per-track design lives in the per-track first-slice PR. | (none) |
| Phase 2 — Tasks (`/speckit-tasks`) | Not yet run; should produce a high-level task list **per track** following the rollout sequence in §8 | tasks.md (future) |

**Why no Phase 1 artifacts?** Spec §3.1 forbids `data-model.md`,
`contracts/*.yaml`, and `quickstart.md` in this PR. Each track has its own
future first-slice PR which will author its own scoped design artifacts at
that time. Authoring them now would presume implementation details that the
gating rules explicitly defer.

---

## 13. Recommended next command

**`/speckit-tasks`** — generate a high-level task list, organized by track
and by rollout slice (§8). Tasks should remain documentation-tagged where
implementation is gated; concrete coding tasks belong to per-slice PRs, not
to this feature's `tasks.md`.

---

*End of plan.*
