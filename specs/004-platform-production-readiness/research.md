# Research: Platform Production Readiness

**Feature ID**: 004
**Plan**: [plan.md](./plan.md)
**Spec**: [spec.md](./spec.md) (clarified 2026-05-16)
**Constitution**: v3.0.0
**Created**: 2026-05-16
**Owner**: Ahmed Shaaban
**Status**: Draft — recommendations only; final selection per item locked
at the per-track first-slice PR

> This document expands the non-blocking research items deferred from
> `spec.md §15.2`. Each section follows the speckit research format:
> **Decision → Rationale → Alternatives considered → Rejected & why →
> Deferred → Gated implementation notes → Open follow-ups**.
>
> Nothing in this document authorizes implementation. All implementation
> remains gated per `plan.md §5`.

---

## 0. Recommendation summary

| # | Topic | Recommendation |
|---|---|---|
| 1 | Load-testing tool | **k6 via Docker image** (`grafana/k6`) — external CLI fallback. **No** in-repo Node-based load tool. |
| 2 | Idempotency replay retention window + first target endpoint | **72 hours** replay TTL; first endpoint **`POST /api/v1/memberships/invite`** (OpenAPI `operationId: createInvitation`). |
| 3 | In-progress marker TTL for `425 Too Early` | **60 seconds** default; per-endpoint override. |
| 4 | Observability vendor & exporter | **OpenTelemetry Collector (OTLP/gRPC)** as the primary exporter; Prometheus scrape adapter for early Grafana dashboards. Managed vendor deferred. |
| 5 | SDK generator + initial output location | **`openapi-typescript` + `openapi-fetch`** (locked by Q3); generate in a **downstream repo** (dashboard or POS), not `packages/sdk`. |
| 6 | Drift-detection mechanism | **Downstream-repo CI** runs the generator and diffs; in-repo CI deferred. |
| 7 | Load environment topology | **Single shared non-production environment** with snapshot reset between runs; not per-release ephemeral. |
| 8 | Dead-letter triage UX | **Admin endpoint behind `RolesGuard`** with operator-only role; CLI deferred. |
| 9 | Outbox design validation | **DB table polling with `FOR UPDATE SKIP LOCKED`**; LISTEN/NOTIFY as a later optimization. BullMQ-only event publishing rejected for durability reasons. |
| 10 | Idempotency middleware shape | **NestJS interceptor** wrapping the existing `IdempotencyKeyStore`; narrow per-endpoint enablement, **not** global. |
| 11 | Redaction policy artifact location | **`.specify/memory/redaction-matrix.md`** using the existing template. |

---

## 1. Load-testing tool (Track A)

### Decision
**k6 via the official Docker image** (`grafana/k6`) is the recommended
first-slice runner. External k6 CLI binary is the acceptable fallback when
Docker is not available on the operator host. **No** in-repo Node-based
alternative.

### Rationale
- k6 is purpose-built for HTTP load with first-class p50/p95/p99 reporting,
  RPS pacing, thresholds, and JS-based scenario authoring — covering every
  Track A required measure (spec §6.4) for the HTTP side without
  custom tooling.
- Docker pin (e.g., `grafana/k6:0.50.0`) keeps the runtime reproducible
  across operator hosts without requiring an `npm install` or a host
  install.
- Scripts live as plain `.js` files **outside** `apps/**` and
  `packages/**` (recommended location: `loadtests/k6/`), so the first slice
  introduces **zero** package dependency changes — satisfying FR-A-011
  and SC-A-004.
- Vendor-neutral: k6 emits results in JSON / Prometheus remote-write /
  OTel formats; downstream wiring is a later decision, not a first-slice
  one.

### Alternatives considered

| Tool | Pros | Cons |
|---|---|---|
| **k6 (external CLI)** | Same script ecosystem as Docker; lighter on operator host | Requires every operator to install matching k6 version; reproducibility burden shifts off-repo |
| **k6 (Docker image)** ← **recommended** | Reproducible; no host install; CI-friendly later | Adds a Docker dep to the load runner (not to the repo) |
| **autocannon** (Node-based) | npm-installable; uses fetch-like API | Pulls Node ecosystem into the load harness; tempts `package.json` adoption → conflicts with FR-A-011; weaker p99 / threshold ergonomics; weaker scenario composition |
| **wrk / wrk2** | Very low overhead | Lua scripting; harder to express auth-bearing tenant-context flows; weaker JSON output for regression-delta comparisons |
| **JMeter** | Mature; GUI-based scenario editing | Heavy; XML config; harder to diff in PRs; overkill for our scale |
| **Vegeta** | Simple; pipe-friendly | Limited scenario composition; weaker for end-to-end tenant flows |

### Rejected
- **autocannon**: rejected primarily because the temptation to add it as a
  dev dependency conflicts with the "no `package.json` change in first
  slice" gate (FR-A-011) — even if dev-only. Secondarily, its threshold
  and scenario story is weaker than k6's.
- **Wrapping an in-house TS load harness**: rejected — would require
  `apps/**` or `packages/**` changes; reinvents what k6 already does well.

### Deferred
- Whether load runs publish results to a shared backend (InfluxDB +
  Grafana, k6 Cloud, or OTel) — deferred to slice 2 of rollout.
- Whether load tests later run in CI — deferred; CI workflow changes are
  gated.

### Gated implementation notes
- First-slice scripts live in `loadtests/k6/` (outside `apps/**` /
  `packages/**`).
- Scripts MUST authenticate via the real auth path; never set internal
  bypass headers.
- Scripts MUST use synthetic tenants (e.g., `tenant-load-A/B/C`); FR-A-008.
- Scripts MUST use ≥3 concurrent tenants for baseline runs to exercise
  cross-tenant RLS (FR-A-009).

### Open follow-ups (non-blocking)
- Empirical p95/p99/error-rate threshold values per flow (slice 2 first
  run).
- Regression delta budget per metric: **recommended `+10%` p95, `+20%` p99,
  `+0.5pp` error rate** — calibrate after the first three baseline runs
  produce a band.

---

## 2. Replay retention window & first idempotency target endpoint (Track D)

### Decision
- **Replay retention window: 72 hours**.
- **First target endpoint: `POST /api/v1/memberships/invite`** (OpenAPI `operationId: createInvitation`).

### Rationale (replay window)
- `IdempotencyKeyStore` defaults to **24h** today; that's enough for
  in-session retries but too short for POS / integration clients that may
  pause overnight, fail, and retry the next morning.
- **72h** covers the worst-case "client disconnected Friday evening,
  retries Monday morning" pattern without ballooning storage. At expected
  RPS for foundation endpoints, this is well under 10 GB of replay records.
- Beyond 72h, the original transaction is almost certainly business-stale
  (the user changed their mind); treating the retry as a new request is
  the safer semantic.
- The window MUST honor PII lifecycle (FR-D-006) — replay bodies containing
  PII are subject to right-to-erasure regardless.

### Rationale (first endpoint)
- `POST /api/v1/memberships/invite` is retry-safe by design: creating an
  invitation has no money side effect, low blast radius, and clear
  business semantics ("the same invitation was meant to be sent twice — it
  is the same invitation").
- It's already covered by 001 contract tests, so the conformance surface
  is well understood.
- POS does not depend on it, so first-slice rollout has no POS coordination
  cost.
- It exercises an audit-emitting code path, which lets the same slice
  validate that idempotency replay does **not** double-emit audit events
  (a critical regression risk).

### Alternatives considered

| Endpoint | Why it was considered | Why not first |
|---|---|---|
| `POST /api/v1/auth/refresh` | Highest-volume mutating call | Tokens have their own retry semantics (jti); idempotency layer would shadow them |
| `POST /api/v1/auth/signin` | Common operation | Security-sensitive (rate-limited differently); coupling idempotency replay to signin is dangerous |
| Role-grant / role-revoke | Audit-heavy | Higher blast radius if replay misbehaves — defer until first-endpoint patterns are validated |
| Any catalog endpoint | High future volume | Catalog isn't implemented yet; would violate plan §6 parallelism contract |

### Rejected
- **Global rollout** as the first slice: explicitly forbidden by FR-D-007;
  global default risks regressing audit-emitting flows that haven't been
  reviewed for idempotency semantics. Multiple HTTP idempotency post-mortems
  in the wider industry trace back to global rollout without per-endpoint
  review.

### Deferred
- Second-endpoint selection (likely `POST /api/v1/invitations/accept` or a
  store-attach mutation) — locked at the second-endpoint PR.
- Whether the replay window is per-endpoint configurable — deferred until
  there's a documented reason (e.g., a long-running webhook integration).

### Gated implementation notes
- The 72h TTL is set at the `IdempotencyKeyStore` level via
  `defaultTtlMs`; no schema change needed (the existing `expires_at` column
  honors it).
- `(tenantId, route, clientId, key)` scoping is achieved at the
  interceptor layer by composing `route` into the key the store sees — no
  store schema change required (plan §3.4.6).

### Open follow-ups (non-blocking)
- Whether to add `route` as a separate column in `idempotency_keys` for
  better observability — deferred; query-side derivation is fine.
- Whether `storeId` should be in the dedup tuple, comparison set, or
  neither — recommendation: comparison-only (request switching stores
  with same key = 409 collision, which is safe).

---

## 3. In-progress marker TTL (Track D, supporting Q1)

### Decision
**60-second default**, per-endpoint override permitted.

### Rationale
- The marker exists to support the `425 Too Early` response (Q1). It must
  outlive the **longest reasonable request** (so that two well-behaved
  retries don't race) but must **expire faster than the replay-record TTL**
  (so a crashed worker doesn't lock a key indefinitely).
- For foundation endpoints, p99 latency targets are well under 5s; a 60s
  TTL is ~12x p99 — generous enough to cover slow paths, short enough that
  a hung server self-heals quickly.
- Per-endpoint override exists for slow paths: a future bulk-import or
  long-running export endpoint may need a 5-10 min marker. The override
  ships as part of that endpoint's first-slice PR.
- If a marker outlives its TTL and the original request actually completed,
  the next retry hits the replay record (200 OK) — not 425; the in-progress
  state is correctly *transitional*, not authoritative.

### Alternatives considered

| TTL | Pros | Cons |
|---|---|---|
| **30s** | Faster self-heal | Risks 425 → 425 → new-request thrash on legitimately slow p99 |
| **60s** ← **recommended** | ~12x p99 for foundation endpoints; self-heals fast enough | Per-endpoint override needed for slow paths |
| **5 min** | Covers any reasonable slow path | Hung server keeps key locked for too long; client UX degrades |
| **Match replay TTL (72h)** | Simpler — one TTL | Worker crash → key locked indefinitely; client cannot recover |

### Rejected
- **No TTL (manual cleanup)**: rejected — a worker crash would leave the
  key locked until an operator intervened.
- **TTL synchronized with replay TTL**: rejected — different semantics
  (in-progress vs completed) demand different cleanup horizons.

### Deferred
- Whether the marker is implemented as a Redis key with `SET NX EX 60` or
  as a Postgres row with an expiry index — recommendation: Redis (faster,
  matches replay-store primary). Locked at Track D first-slice PR.
- Whether the marker stores any payload (e.g., `started_at`,
  `request_id`) for observability — recommendation: minimal payload
  (just `started_at`); the `request_id` is in the trace.

### Gated implementation notes
- The marker MUST be set with `SET NX` (atomic), so two concurrent
  requests can't both think they're the original.
- Marker deletion on response MUST be best-effort; never block response
  emission on marker cleanup.
- The 425 response body MUST follow the uniform error envelope
  (Constitution §III) — no original-request metadata leaked.

### Open follow-ups (non-blocking)
- Whether 425 responses include a `Retry-After` header with a suggested
  delay — recommendation: yes, value = remaining marker TTL or a small
  constant (e.g., 2s) clamped.

---

## 4. Observability vendor & exporter target (Track B)

### Decision
- **Primary**: OpenTelemetry Collector with OTLP/gRPC.
- **Adapter**: Prometheus scrape endpoint exposed by the API + worker
  (`/metrics`) for early Grafana dashboards.
- **Managed vendor**: deferred. The Collector can fan out to a managed
  vendor later without changing application code.

### Rationale
- OTel Collector is the single most vendor-neutral observability surface
  available — every major managed observability vendor supports OTLP
  ingestion (Datadog, New Relic, Honeycomb, Grafana Cloud, etc.).
- Application code instruments via the OTel SDK only; the Collector
  decides where the data goes. Switching vendors is a Collector config
  change, not a code change — preserves FR-B-007 (vendor neutrality).
- Prometheus scrape coexists with OTel today (the OTel SDK can expose a
  Prometheus endpoint). Early dashboards can scrape directly while the
  Collector pipeline matures.
- Slow-query threshold (per spec §15.2): **500ms** default; alert when
  sustained > 5/min over a 5-min window. Rationale: foundation endpoint
  queries are all under 50ms in 001 baselines; 500ms is a 10x flag, not a
  noise floor.

### Alternatives considered

| Approach | Pros | Cons |
|---|---|---|
| **OTel Collector (OTLP)** ← recommended | Vendor-neutral; future-proof; supports fan-out | Requires Collector deployment (infra, gated) |
| **Direct Prometheus scrape only** | Simple; no Collector dep | Locks us into Prometheus naming early; harder to switch to managed vendor later |
| **Direct managed-vendor SDK** (e.g., dd-trace) | Out-of-box dashboards | Vendor lock-in — violates FR-B-007; auto-instrumented signals may leak PII without explicit review |
| **Logs-only (no metrics)** | Lowest infra footprint | Aggregation cost; can't satisfy spec §7.5 queue-lag / job-duration histogram requirements |

### Rejected
- **Vendor-managed SDK (Datadog dd-trace, NewRelic apm)** as primary:
  rejected for FR-B-007 and for the auto-instrumentation PII risk.
- **No OTel** (pino + Prometheus only): rejected — traces are non-optional
  for cross-tenant debugging (§11.2 scenario in spec).

### Deferred
- Specific Collector configuration (exporters, processors, samplers) —
  belongs to a future infra PR.
- Whether to use OTLP/HTTP instead of OTLP/gRPC — preference is gRPC for
  efficiency, but HTTP is a valid fallback.
- Trace sampling strategy (head vs tail, sampling ratio) — locked at the
  observability first-slice PR.

### Gated implementation notes
- The OTel Collector deployment itself is **infrastructure** and out of
  scope for this feature per spec §3.1 / §3.2.
- The pino → OTel logs bridge requires a pino transport plugin — adding
  it touches `package.json` and is **gated**.
- Slow-query threshold (500ms) is exposed as a runtime config (no code
  constant); tunable per environment.

### Open follow-ups (non-blocking)
- Whether to ship dashboards-as-code (Grafana JSON) in the same repo or
  in a separate `ops/` repo — recommendation: separate `ops/` repo so this
  monorepo stays application-focused. Locked at slice 3.

---

## 5. SDK generator (Track E)

### Decision (locked by Q3 / spec §1.5)
**`openapi-typescript` + `openapi-fetch`** is the directional default.
**No `packages/sdk` in the first implementation slice.**

### Rationale
- TypeScript-native: matches the platform's stack; no Java toolchain (as
  `openapi-generator` requires).
- Lightweight: `openapi-fetch` is ~5kb minified with zero runtime
  dependencies beyond `fetch`. Tree-shakeable.
- Strict type safety: `openapi-typescript` produces strict types from
  OpenAPI 3.1 with high fidelity; preserves discriminated unions, `oneOf`,
  and nullable shapes.
- Header support: trivially extends to `Idempotency-Key` (Track D) and
  tenant/store context headers (foundation 001) via the typed
  `Init` parameter.
- Generator stability: `openapi-typescript` is in active maintenance
  (Drew Powers, Honcho/Honc team); `openapi-fetch` is part of the same
  family.

### Alternatives considered

| Tool | TypeScript | Build deps | Output size | Notes |
|---|---|---|---|---|
| **`openapi-typescript` + `openapi-fetch`** ← recommended | Native | None | Tiny | The directional lock |
| `orval` | Native | Multiple (axios, react-query, etc.) | Larger | Strong for React Query integration; overkill if you don't need it |
| `openapi-generator` (Java) | Optional | Java toolchain | Larger | Polyglot strength; Java install requirement is a CI burden |
| `hey-api/openapi-ts` | Native | Optional | Medium | Newer; good ergonomics; smaller community; revisit if `openapi-typescript` stalls |

### Rejected
- `openapi-generator`: rejected primarily for the Java toolchain
  requirement (would need to install JRE in every consumer's CI). The
  output quality is high, but the operational cost is not justified for a
  TS-only consumer base.
- `orval`: rejected as default — its strengths (React Query, axios) are
  client-framework choices the dashboard/POS should make independently.
  Mandating it from the SaaS repo over-couples to client tech.

### Deferred
- The actual first-slice consumer (dashboard vs POS) — depends on which
  downstream repo is ready first.
- Whether to publish a tagged OpenAPI artifact (e.g., as a GitHub release)
  so downstream consumers pin a known contract version — recommendation:
  yes; locked at slice 8.

### Gated implementation notes
- **`packages/sdk` is NOT introduced in the first slice** (FR-E-007 +
  Q3). This is a hard gate.
- No `package.json` / `pnpm-lock.yaml` entry for `openapi-typescript` or
  `openapi-fetch` in **this** repo. Those dependencies live in the
  downstream consumer (dashboard / POS) for the first slice.
- Generated client files MUST NOT be hand-edited (FR-E-005).
- Generation MUST be deterministic — given the same OpenAPI source +
  generator version, the output MUST be byte-identical (within an
  explicitly tolerated formatter delta).

### Open follow-ups (non-blocking)
- Whether the OpenAPI source is versioned (e.g., semver tags) for
  downstream pinning — recommendation: yes; tied to release process.
- Whether `Idempotency-Key` becomes a typed input parameter in the
  generated fetch client or a `headers` field — recommendation: typed
  parameter on the methods that declare `x-idempotency: required` or
  `optional`. Locked at the first generation slice.

---

## 6. Drift-detection mechanism (Track E)

### Decision
**Downstream-repo CI** runs the generator and diffs against the committed
client. In-repo CI is deferred.

### Rationale
- Keeps this repo unchanged in the first slice (no CI workflow change, no
  generated file, no `packages/sdk`).
- Each downstream consumer owns its own drift gate, scoped to its own
  release cadence. Dashboard can re-generate weekly; POS can re-generate
  per release.
- The OpenAPI source IS this repo's source of truth (Constitution §IV);
  drift is a *consumer-side* concern — they are the ones whose code
  would break.
- A future in-repo CI check is reasonable once `packages/sdk` (or
  equivalent) exists, but it's not first-slice-shaped.

### Alternatives considered

| Mechanism | Where it runs | Trade-off |
|---|---|---|
| **Downstream-repo CI** ← recommended | dashboard / POS repo CI | Each consumer owns its drift gate; this repo stays clean |
| Tagged artifact + manual re-pin | Anywhere | No automated drift detection; relies on consumer discipline |
| In-repo CI re-generate + diff | this repo's CI | Requires CI workflow change → gated; over-couples this repo to consumer tooling |
| Pre-commit hook | Each developer's machine | Inconsistent — depends on local env; not enforceable |

### Rejected
- **In-repo CI as first slice**: rejected because it requires a CI
  workflow change (gated) and pre-commits this repo to a specific
  generator version that downstream consumers may not be ready for.

### Deferred
- Whether to publish a tagged OpenAPI artifact alongside each release —
  recommendation: yes (separate decision, slice 8).
- How to surface drift to the OpenAPI authors when downstream CI flags it
  — recommendation: a labeled GitHub issue auto-opened by downstream CI;
  details out of scope.

### Open follow-ups (non-blocking)
- Whether this repo should reject OpenAPI changes that downstream CIs
  have flagged as breaking — recommendation: no automatic block; it's a
  reviewer judgment call.

---

## 7. Load environment topology (Track A)

### Decision
**Single shared non-production environment** with snapshot reset between
runs. Not per-release ephemeral.

### Rationale
- Cost: an always-on staging env with Postgres + Redis + BullMQ + the
  full API + worker stack is feasible at the platform's scale; spinning a
  fresh env per release multiplies that cost.
- Reproducibility: a known synthetic-tenant dataset (`tenant-load-A/B/C`
  with deterministic row counts) is easier to maintain in a single shared
  env than re-seeding ephemeral envs.
- Risk: as long as the snapshot is reset between baseline/regression
  runs, sequential runs won't pollute each other.
- FR-A-007 forbids running against production; this satisfies that.

### Alternatives considered

| Topology | Pros | Cons |
|---|---|---|
| **Single shared non-prod** ← recommended | Cheap; reproducible; data is easy to manage | Sequential runs only; one run blocks another |
| Per-release ephemeral | Parallel runs; no contamination | Setup cost; data-shape drift between envs |
| Multi-tenant production-shadow (dual-write) | Most realistic | Requires shadowing infra; PII risk; out of scope |
| Local-only (Testcontainers-style) | Fastest iteration | Doesn't measure real network/DB pressure; not a baseline |

### Rejected
- **Ephemeral per release**: rejected for cost and operational drift —
  not worth the parallelism gain at this team size.
- **Production shadow**: rejected for PII risk and infra cost; revisit
  only after the platform's traffic shape justifies it.

### Deferred
- Snapshot-reset mechanism (Postgres logical dump? `pg_restore` from a
  pre-built fixture? volume snapshot?) — recommendation: pre-built
  fixture loaded via `psql` script; deterministic and version-controlled.
  Locked at slice 2 PR.
- Whether the load env shares infra with the dev / preview environment —
  recommendation: separate to avoid noisy-neighbor effects.

### Gated implementation notes
- The non-production load env itself is **infrastructure** (out of scope
  for this feature). Documenting the *requirements* of that env is in
  scope; standing it up is not.

### Open follow-ups (non-blocking)
- Frequency of fixture re-builds — recommendation: weekly or per
  significant 001/003 schema change. Locked at slice 2.

---

## 8. Dead-letter triage UX (Track C)

### Decision
**Admin endpoint behind `RolesGuard`** with an operator-only role. CLI
deferred.

### Rationale
- An HTTP admin endpoint reuses the existing auth + RBAC stack — no new
  trust boundary, no new secret material.
- Operators can build their own UI (a Postman collection is sufficient
  for triage in the first slice).
- An admin endpoint can return *redacted* dead-letter context (tenant,
  store, event_type, last_error, correlation_id, retry_count) without
  exposing payload — naturally satisfies FR-C-008 redaction.
- CLI defers until a real operator workflow demands it.

### Alternatives considered

| Mechanism | Pros | Cons |
|---|---|---|
| **Admin endpoint** ← recommended | Reuses auth + RBAC; redacted by default; future-friendly | Requires `apps/api` route (gated, but small) |
| Operator CLI (TS) | Familiar to backend devs | New trust boundary; needs auth wiring; over-engineered for first slice |
| Direct Postgres access | Most flexible | Bypasses RLS; violates Constitution §II ("DB role MUST NOT bypass RLS"); rejected outright |
| Out-of-band tool (e.g., Retool) | Fast UI | New vendor lock-in; vendor-neutral observability surface preferred |

### Rejected
- **Direct Postgres access** for triage: rejected — violates Constitution
  §II (the runtime DB role MUST NOT bypass RLS).
- **Out-of-band SaaS tool** (e.g., Retool, Forest Admin): rejected for
  first slice — vendor lock-in; data exposure to a third party.

### Deferred
- Endpoint surface (list dead-lettered, retry, force-purge, redact-PII) —
  locked at the outbox first-slice PR.
- Whether triage actions emit their own audit events — recommendation:
  yes (a triage action is auditable governance per Constitution §XIII).

### Gated implementation notes
- The admin endpoint requires `apps/api` work — **gated** per plan §5.
- The operator-only role requires a `RolesGuard` extension — verify it
  doesn't accidentally bypass tenant context.

### Open follow-ups (non-blocking)
- Rate-limit the admin endpoint? — recommendation: yes, modest (e.g., 60
  requests per operator per minute) to prevent accidental scans.

---

## 9. Outbox storage & drainer mechanism (Track C)

### Decision
- **DB table polling** with `SELECT ... FOR UPDATE SKIP LOCKED` as the
  drainer claim mechanism.
- LISTEN/NOTIFY as a **later optimization** to reduce poll latency.
- **BullMQ-only event publishing rejected** as the primary mechanism —
  it doesn't provide durability against the "transaction commit + queue
  publish fail" race.

### Rationale
- Polling + `FOR UPDATE SKIP LOCKED` is the canonical transactional outbox
  pattern: durable (events live in the DB), correctly transactional (events
  are inserted in the same TX as state changes), and safely concurrent
  (multiple drainers can run without double-claiming).
- LISTEN/NOTIFY reduces tail-latency for low-volume queues but adds
  drainer code complexity; the polling drainer already handles the
  correctness story.
- "BullMQ-only" (publish directly to BullMQ inside the transaction)
  loses the entire purpose of the outbox — if the BullMQ publish fails
  *after* the transaction commits, the event is gone. Constitution §V
  ("Async Work Belongs in Workers") + §III ("Backend Authority &
  Integrity") together imply the durable record IS the contract.
- "Transaction callback" approach (run a callback after `COMMIT` to
  publish to BullMQ): rejected — same race window as BullMQ-only.

### Alternatives considered

| Approach | Durability | Complexity | Notes |
|---|---|---|---|
| **DB table polling, `FOR UPDATE SKIP LOCKED`** ← recommended | Strong | Low | Canonical pattern; well-understood |
| LISTEN/NOTIFY + polling fallback | Strong | Medium | Lower latency; later optimization |
| BullMQ-only event publishing | Weak | Low | Loses the outbox guarantee — rejected |
| Transaction callback (after commit) | Weak | Low | Same race as BullMQ-only — rejected |
| Logical replication / CDC (Debezium) | Strong | High | Overkill at this scale; vendor commitments |

### Rejected
- **BullMQ-only / transaction-callback**: rejected because they don't
  solve the failure case the outbox exists to solve (DB commits + queue
  publish fails). They're not "outbox patterns" — they're "BullMQ
  patterns" mislabeled.
- **Debezium / CDC**: rejected for the first slice — operational and
  cost overhead far exceeds the value. Revisit if event volume grows.

### Deferred
- Specific poll interval (1s / 5s / 10s) — recommendation: start at 5s,
  tune from observability data. Locked at slice 7 PR.
- Specific retry budget per event type — recommendation: 8 attempts
  default with bounded exponential backoff. Per-event-type overrides
  deferred until a real event needs one.
- LISTEN/NOTIFY adoption — deferred to a later optimization slice.

### Gated implementation notes
- `outbox_events` table creation, drainer worker, producer helper, BullMQ
  queue config, TTL indexes, retention cleanup job — all gated per plan
  §5.
- First slice MUST be **`audit.event.created`** only (single narrow event
  type; FR-C-007).
- Drainer worker MUST establish tenant context before any DB access
  beyond the outbox table itself (FR-C-003).
- Outbox table RLS must include the runtime role; the drainer reads with
  `BYPASSRLS`-free access pattern (queries scoped by tenant context).

### Open follow-ups (non-blocking)
- Whether to add a per-event-type partition key for high-throughput event
  types — deferred; revisit if outbox table grows beyond ~10M rows.
- Whether dead-lettered events get a separate table (`outbox_dead_letters`)
  for easier retention reasoning — recommendation: same table with a
  state column is simpler; revisit if retention queries get slow.

---

## 10. Idempotency middleware shape (Track D)

### Decision
**NestJS interceptor** wrapping the existing
`packages/shared/src/idempotency/store.ts::IdempotencyKeyStore`. Narrow
per-endpoint enablement (opt-in via decorator + OpenAPI declaration).
**Not** global blanket middleware.

### Rationale
- An interceptor sees the validated request body (the fingerprint must be
  computed from validated input, not raw bytes — otherwise whitespace
  differences would cause false collisions).
- An interceptor can short-circuit a response (return 425 / 409 / replay
  without invoking the handler).
- Per-endpoint opt-in matches FR-D-007 (no global rollout) and FR-D-008
  (per-endpoint OpenAPI policy declaration). A `@Idempotent('required')`
  or `@Idempotent('optional')` decorator is the natural fit.
- The existing `IdempotencyKeyStore` already has the fingerprint /
  collision / Redis-mirror semantics. Track D adds the HTTP wiring and the
  in-progress marker.

### Alternatives considered

| Shape | Where it sees the body | Opt-in story | Notes |
|---|---|---|---|
| **NestJS interceptor + decorator** ← recommended | Post-validation | Per-method decorator | Matches NestJS idioms; clean opt-in |
| Global middleware | Pre-validation (raw body) | All-or-nothing | Forbidden by FR-D-007; also can't see validated body |
| Per-controller service handling | Post-validation | Per-controller boilerplate | Reinvents what an interceptor abstracts; harder to ensure observability emission |
| Guard | Pre-handler, can short-circuit | Per-method | Conceptually wrong: guards answer "is this request authorized?", not "is this a retry?" |

### Rejected
- **Global middleware**: explicitly forbidden by FR-D-007. Also can't
  see the validated body without re-running validation.
- **Per-controller service**: rejected for boilerplate — every controller
  would re-implement the same idempotency dance. Easy to forget the
  observability counter emission.
- **Guard**: conceptually wrong; semantic confusion in code review later.

### Deferred
- Whether the decorator carries the per-endpoint TTL override or whether
  TTL is route-config — recommendation: decorator carries it (e.g.,
  `@Idempotent('required', { replayTtlSec: 86400, inflightTtlSec: 60 })`).
  Locked at slice 5.
- Whether the interceptor handles 425 by setting a `Retry-After` header
  with the remaining in-progress TTL — recommendation: yes.

### Gated implementation notes
- The interceptor lives under `apps/api/` — gated per plan §5.
- The in-progress marker is a Redis key with `SET NX EX 60`; reuse the
  existing Redis connection from the `IdempotencyKeyStore` (no new
  package needed).
- The decorator + interceptor MUST be registered at the route level
  (not the global level), so missing the decorator means "no
  idempotency" — never "accidental global rollout."

### Open follow-ups (non-blocking)
- Whether to expose a typed `IdempotencyContext` to handlers (e.g.,
  `req.idempotency.key`) for handler-side logic — recommendation: no for
  first slice; handlers should not know they're behind idempotency.
- Whether replay records preserve the original response's `request_id` /
  `actor_id` — recommendation: yes; the replay represents the *original*
  authorization decision, not the retrier's (FR-D-009).

---

## 11. Redaction policy artifact location

### Decision
**`.specify/memory/redaction-matrix.md`** using the existing
`.specify/templates/redaction-matrix-template.md` template.

### Rationale
- The redaction policy is a **constitution-level invariant**, not a
  feature-local concern. Constitution §XIV ("logger-boundary redaction is
  mandatory") binds every feature.
- `.specify/memory/` is the existing location for constitution-level
  artifacts (the constitution itself, the architecture impact map).
- The repo already has a template for it
  (`.specify/templates/redaction-matrix-template.md`), implying the
  intended location is here.
- Single source of truth — every track's logger boundary defers to it;
  reviewers always know where to look.

### Alternatives considered

| Location | Pros | Cons |
|---|---|---|
| **`.specify/memory/redaction-matrix.md`** ← recommended | Constitution-level location; template exists; single source of truth | None |
| `docs/security/redaction.md` | Standard docs location | Decouples from constitution-level invariants — risks drift |
| Inside spec.md or plan.md of 004 | Co-located with the feature | Wrong scope — it's a platform invariant, not a feature artifact |
| `packages/shared/src/logger/redaction-config.ts` (as code) | Single source of truth at runtime | Couples policy review to code review; reviewers may miss policy changes |

### Rejected
- **Code-as-policy**: rejected primarily because it forces every policy
  change through a code review when the policy is a constitutional
  concern. A separate doc forces explicit policy review.

### Deferred
- Whether the matrix is *enforced* by a runtime check (e.g., a startup
  assertion that the logger has the documented redacted fields configured)
  — recommendation: yes, eventually; deferred to slice 4 first
  observability instrumentation PR.

### Gated implementation notes
- Adding the matrix artifact is **gated** per plan §5 (it lives in
  `.specify/memory/`, which is constitution-adjacent and reviewer-only).
- Add-only by default (FR-B-005); removing a field requires explicit
  audit.

### Open follow-ups (non-blocking)
- Whether the matrix has a versioned changelog — recommendation: yes,
  embedded in the doc; matches the constitution's pattern.

---

## 12. Intentionally deferred (post-tasks scope)

Items not covered in this research and deferred to **later** work:

- **Empirical baseline numbers** for Track A pass/fail gating (p95/p99/
  error-rate thresholds per flow) — require a first run against a
  realistic load env.
- **Per-event-type retry budgets** for Track C — wait for at least one
  real production event type before tuning.
- **Specific Grafana dashboards** for Track B — out of scope (lives in
  `ops/` repo per §4).
- **Dashboards-as-code / alerts-as-code** content — out of scope.
- **Cardinality budgeting** beyond the spec's "no `tenant_id` as label"
  rule — revisit once real metric volume is measured.
- **OpenAPI versioning policy** (semver tags, branch model) — out of
  scope; tied to release process, not to feature 004.
- **`packages/sdk` introduction conditions** — Q3 defers until
  dashboard/POS contract needs stabilize.

---

## 13. Gated implementation notes (consolidated)

The following are **gated** per plan §5 and must NOT happen in this
planning PR:

- Any change under `apps/**` or `packages/**`.
- Any `package.json` / `pnpm-lock.yaml` change.
- Any DB schema or SQL migration.
- Any OpenAPI contract change.
- Any CI workflow change.
- Any generated file.
- k6 script files (slice 2, gated).
- The redaction matrix artifact at `.specify/memory/redaction-matrix.md`
  (slice 3, gated).
- The observability instrumentation (slice 4, gated).
- The idempotency interceptor + first-endpoint enablement (slice 5,
  gated).
- The outbox table + drainer + first event type (slice 7, gated).
- The downstream-repo SDK generation (slice 9, lives outside this repo).

---

## 14. Open questions non-blocking for `/speckit-tasks`

None of the items below block task generation. Each is callable out as a
"calibration TBD at slice N" task; none requires a clarification round.

- Track A pass/fail thresholds per flow (TBD at slice 2 first run).
- Track A regression delta budget calibration (TBD after 3 baselines).
- Track A fixture re-build frequency (recommended weekly; TBD at slice 2).
- Track B slow-query threshold tuning (recommended 500ms; tune after
  slice 4 data).
- Track B trace sampling strategy (TBD at slice 4).
- Track C outbox poll interval (recommended 5s; tune from observability).
- Track C dead-letter admin endpoint surface (TBD at slice 7).
- Track D 425 `Retry-After` header value (recommended remaining marker
  TTL or 2s clamped; TBD at slice 5).
- Track D second-endpoint selection (TBD at second-endpoint PR).
- Track E first-slice consumer (dashboard vs POS — depends on which
  downstream repo is ready).
- Redaction matrix changelog format (TBD at slice 3).

---

*End of research.*
