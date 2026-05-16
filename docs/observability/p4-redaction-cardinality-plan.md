# P4 Redaction + Cardinality — Pre-Flight Plan

**Feature**: 004-platform-production-readiness
**Phase**: P4 (Track B instrumentation, all `[GATED]`)
**Lane**: B — Redaction, structured logging, metric cardinality
**Status**: Approval-ready plan. **DOCS-ONLY**. No runtime code, no tests, no
package changes authored by this PR.
**Constitution**: v3.0.0 (Principles VII, XIV, II, VIII)
**Created**: 2026-05-16
**Owner**: Track B Observability owner

> **Planning artifact only.** This document records the exact files, hooks,
> classifications, and validation steps the future P4 redaction-and-cardinality
> wiring slice will touch. Listing a future file here is **not approval to
> write it**. Per `specs/004-platform-production-readiness/plan.md §5` and
> `tasks.md §1.2`, every task this plan references is `[GATED]` and requires a
> separate, scoped, named approval PR before any commit lands.

---

## 1. Scope and tasks covered

This plan covers the **cross-cutting** subset of P4 — the redaction policy
wiring, the structured-log field requirements, the cardinality static check,
the package-change risk assessment, and the local operator validation that
proves PII does not leak through `/metrics`. API-specific signal-presence /
emission planning lives in **Lane A**; worker-specific planning lives in
**Lane C**.

### Tasks covered by this plan

| Task | Description | Status |
|---|---|---|
| **T461** | Static cardinality check: no signal carries `tenant_id` / `store_id` / `user_id` / `actor_id` | Planned — file path locked |
| **T462** | Redaction test: a fixture endpoint emits a PII canary; canary never appears in pino output or metric labels | Planned — file path locked |
| **T473** | Wire the redaction matrix into the pino transport at the **logger boundary** (call-site redaction patterns rejected at review) | Planned — wiring sites identified |
| **T474** | Add structured-log fields (`request_id`, `tenant_id`, `store_id`, `actor_id`, `correlation_id`) to the pino logger config | Planned — extension points identified |
| **T482** | Validate no `package.json` change unless a pino transport plugin was approved separately (also `[GATED]`) | Risk-assessed (see §10) |
| **T483** | Operator validation: a real local dev run scrapes `/metrics` and shows every signal without PII | Validation script documented |

---

## 2. Source-of-truth references

These are the canonical sources this plan defers to. Divergence is a defect
in this plan, not in the sources.

- **Redaction matrix**: `.specify/memory/redaction-matrix.md` — single source
  of truth (FR-B-005, FR-B-011, Constitution §XIV). This plan **consumes**
  the matrix; it does not modify it. The matrix is **add-only by default**
  (§1 changelog block).
- **Signal catalogue**: `docs/observability/signals.md` — §4 (structured-log
  fields), §6 (rejected labels), §1–§3 (signal labels). This plan asserts
  cross-cutting properties the catalogue declares.
- **Logger primitive**: `packages/shared/src/logger/pino.ts` — existing
  `createLogger({ service, redactPaths? })` with `DEFAULT_REDACT_PATHS` and
  `withRequestContext(logger, ctx)`.
- **Spec**: `specs/004-platform-production-readiness/spec.md` §7.6 (PII
  redaction), §7.7 (cardinality), §7.4 (RLS-context-failure signal).
- **Plan**: `specs/004-platform-production-readiness/plan.md` §3.2.2
  (redaction policy artifact location), §3.2.1 (cardinality table footer).
- **Research**: `specs/004-platform-production-readiness/research.md` §11
  (redaction policy artifact location), §4 (observability vendor target).
- **Constitution**: `.specify/memory/constitution.md` §VII (Observable
  Systems), §XIV (PII & Data Lifecycle Discipline), §VIII (Reproducible
  & Versioned Releases — add-only matrix).

---

## 3. Existing surface (discovered, do not edit)

### 3.1 Pino logger primitive — `packages/shared/src/logger/pino.ts`

```
createLogger({ service, level?, redactPaths?, pretty?, bindings? }) → Logger
withRequestContext(logger, { request_id, tenant_id?, user_id?, store_id? }) → child Logger
DEFAULT_REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie',
  'req.headers["set-cookie"]', 'res.headers["set-cookie"]',
  'headers.authorization', 'headers.cookie', 'headers["set-cookie"]',
  'password', 'password_hash', 'passwordHash',
  'token', 'access_token', 'refresh_token', 'session_token',
  'api_key', 'apiKey', 'secret',
  '*.password', '*.password_hash', '*.token', '*.secret',
]
```

**Today this list operates at the pino redact-paths layer** — a property-name
matcher, run by pino itself, that censors values to `[REDACTED]` before
serialization. This **is** logger-boundary redaction in the pino sense (it
runs at the serializer, not at call sites). The matrix in
`.specify/memory/redaction-matrix.md` is the **policy source**; the redact
list above is the **enforcement mechanism**.

**Gap this lane closes**: the matrix is broader than the current list (§3.2
PII fields like `email`, `phone`, `address`, `name`; §3.3 PII-suspect fields
like `body`, free-text `note`/`comment`/`description`; §4 per-emit-site
serializers). T473 expands `DEFAULT_REDACT_PATHS` and introduces emit-site
serializers to cover the matrix in full.

### 3.2 Existing structured-log fields

The current `withRequestContext` child logger emits `request_id`,
`tenant_id`, `user_id`, `store_id`. The signal catalogue (§4) names the same
fields with one rename and one addition:
- `user_id` → keep as the **subject identifier**; the spec also names
  `actor_id` (audit/auth semantics). These are aliases for the same concept;
  the matrix §3.4 classes them both as "business" / loggable. **Decision**:
  the field name in logs is **`actor_id`** when emitted by audit / auth /
  security-relevant code paths, and **`user_id`** when emitted by general
  request handling. Both are populated from `request.principal?.userId`. The
  redundancy is acceptable; making either of them silently rename the other
  is more confusing than carrying two.
- `correlation_id` — **NEW** field; not yet emitted. Required for async work
  (FR-B-004). Source: traced-context carrier (`packages/shared/src/observability/bullmq-propagation.ts`) — the `traceparent` extracted from job data. For HTTP, `correlation_id` defaults to `request_id` (1:1) unless the request
  carries an upstream correlation header (TBD per T474).

### 3.3 ALS bridge — `apps/api/src/context/context.als.ts`

The existing AsyncLocalStorage stores the resolved tenant context once
`TenantContextGuard` has run. The logger child can read from ALS to attach
established `tenant_id` / `store_id` / `actor_id` to every log line emitted
**after** the guard, not just the request entry/exit line. T474 wires this
read.

### 3.4 Existing redaction precedent — `apps/api/test/audit/redaction.spec.ts`

The audit pipeline's redaction test exercises a `hasForbiddenField` helper
against a typed forbidden-key list, including Testcontainers integration that
proves persisted DB rows never carry PII. **T462 follows this pattern** but
extends it to **logs** and **metric labels**, not just persisted DB
columns.

### 3.5 No existing metric-label surface yet

There is **no current `apps/api` or `apps/worker` code** emitting OTel
metrics; that's what Lane A and Lane C plan. This lane's T461 cardinality
check therefore has nothing to fail against today — it is a **future
defense**, designed to fail RED the moment a P4 instrumentation slice
registers a forbidden label.

---

## 4. Redaction matrix classes (from `.specify/memory/redaction-matrix.md`)

Verbatim cross-reference to the matrix sections. This lane **consumes** the
matrix; it does not redefine the classes.

| Class | Source section | Examples (non-exhaustive) | Logger boundary action |
|---|---|---|---|
| **Credential** | §3.1 | password, password_hash, access_token, bearer_token, Authorization header, Cookie value, session_id cookie, refresh_token, api_key, DB/Redis/queue credentials, webhook signing keys, invitation/password-reset/email-verification tokens, raw idempotency_key | Unconditionally censored to `[REDACTED]` at the serializer; emission is a defect even though the serializer catches it. |
| **PII** | §3.2 | email, phone, address fields, full_name / name / display_name, date_of_birth, national_id, passport_number, tax_id, ip_address, payment-card pan_last4 / card_brand | Redacted unless field-level review records an exception in the matrix. |
| **PII-suspect** | §3.3 | full request body, full response body, free-text `note`/`comment`/`description`/`feedback`, outbox `payload`, validation-error rejected value | Redacted by default; can be shaped into structured field-level logs only after a matrix amendment. |
| **Business** | §3.4 | tenant_id, store_id, correlation_id, request_id, actor_id/user_id (subject), event_id, route, method, status_class, job_name, queue_name, event_type, error_class | Safe to log. **Never a metric label** (see §6). |
| **Public** | §3.5 | Documented public artifacts | No constraint. |

The five classes above are the inputs to T473's per-emit-site serializer
table.

---

## 5. Logger-boundary redaction rule

> Constitution §VII + FR-B-005 (non-negotiable). Redaction is enforced **at
> the logger boundary** — at the pino transport serializer and at the
> OpenTelemetry log exporter — **not at call sites**.

### 5.1 What "logger boundary" means in this codebase

There are two boundaries today, both consumed by `createLogger`:

1. **Pino `redact` option** — runs at serialization time per the `redact.paths` array. This is the **enforcement mechanism** for structured-field censoring.
2. **Pino `serializers` option** — per-binding serializer functions (e.g., `req`/`res`/`err` serializers). This is the **enforcement mechanism** for shaping complex objects (replacing a full `req` with just the route+method+safe headers, etc.).

Together they are "the logger boundary" — distinct from any call-site sanitization.

### 5.2 What T473 changes

- **Extend** `DEFAULT_REDACT_PATHS` in `packages/shared/src/logger/pino.ts` to add the matrix §3.1 credential list and §3.2 PII list. Each addition is **add-only** per the matrix changelog rule.
- **Add** per-emit-site pino `serializers` registrations in a new file `packages/shared/src/logger/redaction.serializers.ts` (or inline in `pino.ts` if the diff stays small — design decision at instrumentation PR). The serializers correspond row-for-row to the matrix §4 table:
  - `auth-failure.serializer.ts` shape (handle attempted-email → emit `email_fingerprint` if at all; never `email`).
  - `worker-failure.serializer.ts` shape (replace `job.data` with `{ event_type, queue_name, request_id }`; redact the rest).
  - `audit-event.serializer.ts` shape (emit only the documented audit record shape; reject extra fields).
  - `rls-failure.serializer.ts` shape (emit `query_class` SHA, never `query` text or params).
  - `validation-failure.serializer.ts` shape (emit `field_path` + `rule`, never the rejected value).
  - `idempotency.serializer.ts` shape (emit `key_fingerprint`, never raw key; emit `fingerprint_mismatch` boolean).

### 5.3 Why call-site redaction is rejected at review

Per FR-B-005 and matrix §4.1 rule 5: a code path that pre-redacts at the call site (e.g., `logger.info({ password: '***' })`) is a **review-blocking defect** even when correct, because:

- It is **not auditable** — there is no single place to verify policy.
- It is **not testable** — every call site would need its own redaction test.
- It is **not enforceable** — new contributors will not pattern-match a manual `'***'` substitution.

Reviewer checklist for any P4 instrumentation PR:
1. `git grep -nE "['\"]\\*+['\"]"` in changed files → expect zero hits in
   logger call args.
2. `git grep -n "redacted" apps/api/src apps/worker/src packages/shared/src` →
   expect hits **only** at the serializer-layer (pino options or `redaction.serializers.ts`).
3. Any new field name that matches a §3.1 / §3.2 / §3.3 classification MUST
   be added to the redact paths or have an amendment recorded in the matrix.

---

## 6. Rejected call-site redaction pattern (worked example)

The slice MUST NOT introduce code like:

```ts
// REJECTED — call-site redaction
logger.info({
  password: '***',           // ← review-blocker per FR-B-005
  email: maskEmail(user.email), // ← review-blocker
  body: pickSafeFields(req.body), // ← review-blocker
});
```

The slice MUST instead introduce:

```ts
// APPROVED — logger boundary
// In packages/shared/src/logger/pino.ts: extend DEFAULT_REDACT_PATHS
// In packages/shared/src/logger/redaction.serializers.ts:
//   register a `req` serializer that drops the body by default
// Call site is unchanged:
logger.info({ req }, 'request received');  // ← the serializer redacts
```

This pattern is enforced by the reviewer checklist in §5.3 **and** by Lane B's
T462 test (§7.2 of this plan), which scrapes the rendered log output for the
PII canary regardless of call-site intent.

---

## 7. Future test files (T461, T462)

> Test-first per Constitution §VI. Both tests MUST be RED before any T473 /
> T474 wiring lands.

### 7.1 `apps/api/test/observability/cardinality.spec.ts` — T461

Static analysis test: registered metric definitions never carry forbidden
labels (FR-B-006).

| What | How |
|---|---|
| Test type | **Unit / static**. No Testcontainers, no DB, no Redis. The test imports the metric-registration modules from `apps/api/src/observability/metrics/api.metrics.ts` (Lane A) and `apps/api/src/observability/metrics/db.metrics.ts` (Lane A), plus `apps/worker/src/observability/metrics/worker.metrics.ts` (Lane C), and inspects the registered descriptors. |
| Inspection strategy | Two complementary checks: (a) compile-time — the typed helpers' parameter types are inspected via TypeScript test imports to ensure no helper accepts `tenant_id` / `store_id` / `user_id` / `actor_id`; (b) runtime — after the SDK is started, iterate the registered metric instruments and assert each instrument's metadata declares only the labels enumerated in `docs/observability/signals.md`. |
| Forbidden-label list (matches signals.md §6) | `tenant_id`, `store_id`, `user_id`, `actor_id`, `email`, `phone`, `address`, `name`, raw `Idempotency-Key`, raw query text, raw query parameters, `error.message`, `field_name`, date/time strings, rendered URL paths. |
| Cross-file scope | A **single** test asserts the cardinality discipline across **all three** registration files (API, DB, worker). Adding a new metric anywhere requires updating its allowed-label list; the test catches drift. |
| Stop condition | If the test cannot be made deterministic before SDK initialization, **fail loudly** — defer to a startup-time assertion that runs the same check at bootstrap, throwing if a forbidden label is detected. Throwing at startup is preferable to a passing CI suite that hides the violation. |

### 7.2 `apps/api/test/observability/redaction.spec.ts` — T462

End-to-end PII canary: a fixture endpoint emits a body containing a known
canary email, and the test scrapes every observability sink to assert the
canary never appears.

| What | How |
|---|---|
| Test type | **Integration**; Testcontainers Postgres; supertest. |
| Canary value | `pii-canary@example.test` — a fictional address under the IETF-reserved `.test` TLD ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606#section-2)); guaranteed never to be a real user. |
| Fixture endpoint | A `/test-canary` endpoint registered **only under `NODE_ENV=test`** (gated by an `if (process.env.NODE_ENV !== 'test') throw new Error(...)` registration check). Accepts a POST with `{ email: 'pii-canary@example.test', notes: '...' }`. The endpoint validates and persists, then throws (forcing exception-filter emission). |
| Assertion 1 (pino output) | Capture pino output via a memory transport for the duration of the test; after the request completes, scan the captured stream for the literal string `pii-canary@example.test`. **Expect zero hits.** If the canary appears, the redaction matrix is not honored at the logger boundary — RED. |
| Assertion 2 (metric labels) | Scrape `/metrics` after the request; assert none of the scraped lines contain `pii-canary@example.test`. Forbidden-label discipline (T461) is the **structural** check; this test is the **content** check that proves the structural rule held in a live run. |
| Assertion 3 (DB persistence — out of scope) | This test does NOT assert on persisted DB content; that's the audit redaction surface (`apps/api/test/audit/redaction.spec.ts`). The two tests are complementary, not duplicative. |
| Cleanup | The fixture endpoint MUST NOT be present in production builds; reviewer checks `git grep -n "test-canary" apps/api/src` → only the `NODE_ENV=test` branch should contain it. |
| Stop condition | If the fixture endpoint cannot be NODE_ENV-gated cleanly, defer T462 — never ship a real endpoint that accepts arbitrary PII for the purpose of "testing" redaction in production. |

---

## 8. Future implementation files (T473, T474)

> Written only after T461 / T462 are RED.

### 8.1 T473 — logger-boundary redaction wiring

| File | Change |
|---|---|
| `packages/shared/src/logger/pino.ts` | Extend `DEFAULT_REDACT_PATHS` with matrix §3.2 paths (`email`, `phone`, `address`, `*.email`, `*.phone`, `*.address`, `name`, `full_name`, `given_name`, `family_name`, `*.name`, etc.); extend with matrix §3.1 paths not already present (`idempotency_key`, raw bodies via `req.body`, `res.body` if logged). |
| `packages/shared/src/logger/redaction.serializers.ts` (new) | Register per-emit-site serializers matching matrix §4 rows. Exposed as a `withMatrixSerializers(loggerOptions)` helper that consumers call from their `createLogger` setup. **No change to existing call sites is required**; the serializers fire at the boundary. |
| `apps/api/src/app.module.ts` | The `ROOT_LOGGER` provider's `createLogger({...})` call adopts the new serializers. |
| `apps/worker/src/worker.module.ts` | Same adoption on the worker side. |

**Order of operations (within the gated PR)**:
1. Land the new serializers as **dead code** (registered but tested only by the unit test of the serializer functions themselves).
2. Update `app.module.ts` and `worker.module.ts` to adopt them.
3. Run T462 against the dev/test env; assert canary does not leak.
4. Run all 001 logging tests (`apps/api/test/common/logging.interceptor.spec.ts` + audit redaction + auth logging) to confirm no regression.

### 8.2 T474 — structured-log field wiring

| File | Change |
|---|---|
| `apps/api/src/common/logging.interceptor.ts` | Read `request.context` (resolved tenant/store/actor from `TenantContextGuard`) **when available** and pass to `withRequestContext`. Today this interceptor passes `tenant_id: null`, `user_id: null`, `store_id: null` — T474 closes that gap. |
| `apps/api/src/context/context.interceptor.ts` | Bridge the resolved context into the request-scoped logger child (the interceptor already bridges into ALS; T474 also bridges into the logger child). |
| `apps/worker/src/audit/audit.worker.ts` and friends | Each worker establishes its own log child with `correlation_id` extracted from the BullMQ trace carrier (`extractTraceContext(job.data.traceContext)`). The `correlation_id` is the W3C `traceparent`'s trace-id portion; this is well-defined per OTel spec. |
| `packages/shared/src/logger/pino.ts` `withRequestContext` | Accept an optional `correlation_id` parameter; emit when provided. Default the `correlation_id` to the `request_id` when absent (HTTP path with no upstream correlation header). |

**Structured-log fields required** (signals.md §4):

| Field | When | Source |
|---|---|---|
| `request_id` | Always | `request.requestId` (HTTP) or `job.id` (worker) |
| `tenant_id` | When established | `request.context.tenantId` / ALS |
| `store_id` | When established | `request.context.storeId` / ALS |
| `actor_id` | When authenticated | `request.principal.userId` |
| `correlation_id` | For async work | `extractTraceContext(carrier).traceparent.traceId`; falls back to `request_id` on HTTP path |
| `route` | HTTP requests | Route template (NOT rendered path) |
| `method` | HTTP requests | HTTP verb |
| `status` | HTTP responses | Numeric status |
| `outcome` | Audit / worker events | Bounded enum (`success`/`failure`/`partial`) |

---

## 9. PII canary strategy

### 9.1 Canary value

- **Email**: `pii-canary@example.test` (RFC 2606 reserved `.test` TLD).
- **Phone (if needed)**: `+1-555-0100` (NANP fictional number).
- **Name (if needed)**: `Canary, Q. PII` (deliberately abnormal capitalization to defeat substring matches).

### 9.2 Where it lives

- The canary values are **constants** in the test file (T462), not in
  application code. They MUST NOT exist anywhere under `apps/**` or
  `packages/**` *outside* a test file.

### 9.3 Where it is asserted absent

| Sink | How asserted absent |
|---|---|
| Pino stdout | Memory transport captures the stream; full-text scan for the literal canary string. Zero hits = GREEN. |
| OTel log exporter (future) | Same memory-stream pattern when the exporter is wired (not in P4 scope; reserved for a later slice). |
| `/metrics` (Prometheus text) | `supertest(app).get('/metrics')`; full-text scan. Zero hits = GREEN. |
| OTel trace exporter | Out of scope for T462 — trace bodies may legitimately carry PII span attributes under the trace-redaction policy, which is a separate (future) artifact. T462 focuses on logs + metrics. |

### 9.4 Why a canary, not field-by-field assertion

A `pii-canary@example.test` substring search detects **any** leak path —
including ones the author did not anticipate (e.g., the field reaches a log
line through a third-party library's stringification of an exception). A
field-by-field assertion only catches the leaks the author thought of.

---

## 10. Metric-label static validation strategy

### 10.1 Three layers of enforcement (defense in depth)

1. **Compile-time (TypeScript)** — typed helpers in `api.metrics.ts` / `db.metrics.ts` / `worker.metrics.ts` accept only documented label keys. A call site that passes `tenant_id` fails the TS compile.
2. **Bootstrap-time (assertion)** — at SDK startup, iterate registered instruments and assert each instrument's documented label set is a subset of the allowed-label registry (a single TypeScript constant exported from `packages/shared/src/observability/metrics-allowed-labels.ts`). If an unknown label is registered, **throw** at bootstrap. The API/worker process refuses to start. This is the runtime arm; it catches dynamic registration paths the TS compiler can't see.
3. **Test-time (T461)** — the cardinality unit test asserts the same property without booting the full app, so CI catches drift early.

The triple defense matters because Prometheus label cardinality explosions
are nearly impossible to recover from in production storage (10x to 100x
storage growth, queries slowing to seconds). A passing CI suite that misses a
forbidden label is worse than an outright failure.

### 10.2 The forbidden-label registry

Single constant exported from
`packages/shared/src/observability/metrics-allowed-labels.ts`:

```
// Conceptual content (not authored by this PR)
export const ALLOWED_METRIC_LABELS = {
  http_request_count: ['route', 'method', 'status_class'],
  http_request_duration_seconds: ['route', 'method'],
  // ...one entry per signal in docs/observability/signals.md §1-§3...
} as const;

export const FORBIDDEN_METRIC_LABELS: ReadonlySet<string> = new Set([
  'tenant_id', 'store_id', 'user_id', 'actor_id',
  'email', 'phone', 'address', 'name', 'full_name',
  'idempotency_key', 'query', 'query_params',
  'error_message', 'field_name', 'path',
]);
```

The first map is the **catalogue contract**; the second set is the
**enforcement guard** for the runtime assertion.

---

## 11. Forbidden labels (FR-B-006 — non-negotiable)

Cross-reference to `docs/observability/signals.md` §6. The matrix below is
the **complete** forbidden-label set this lane enforces:

| Forbidden label | Why | Where it does live |
|---|---|---|
| `tenant_id` | Unbounded cardinality; PII-adjacent. | Logs (always when established); traces. |
| `store_id` | Unbounded cardinality (multiplies tenant count). | Logs; traces. |
| `user_id` | Unbounded; PII-adjacent. | Logs; traces. |
| `actor_id` | Unbounded; PII-adjacent. | Logs; traces. |

These four are the **mandatory-forbidden** labels named in the lane's
explicit allowlist. The signals catalogue §6 names additional forbidden
labels (raw email, phone, idempotency key, query text, error message text,
field name, date/time strings); this lane enforces all of them at the same
gate.

---

## 12. Structured log fields (required)

Cross-reference to `docs/observability/signals.md` §4 and the matrix §3.4
(business class). These fields MUST appear on **every log line** when
available:

| Field | Required when |
|---|---|
| `request_id` | Always (HTTP request) or always (worker job) |
| `tenant_id` | When tenant context has been established |
| `store_id` | When store context has been established |
| `actor_id` | When the request is authenticated |
| `correlation_id` | For async work (worker job; HTTP→worker handoff) |

**Today** the logger child includes `request_id`, `tenant_id` (often null),
`user_id` (often null), `store_id` (often null). T474 closes three gaps:

1. Populate `tenant_id` / `store_id` from the post-guard context (today the
   logging interceptor passes nulls; the context interceptor runs after).
2. Add `actor_id` alongside `user_id` for audit / auth code paths.
3. Add `correlation_id` from the trace carrier (HTTP→worker handoff and
   worker-internal logs).

---

## 13. Package-change risk assessment (T482)

### 13.1 Likely package additions in the P4 instrumentation slice

| Package | Reason | Owner |
|---|---|---|
| `@opentelemetry/sdk-metrics` | Metrics SDK (separate from trace SDK already present). | Lane A / Lane C (this lane consumes). |
| `@opentelemetry/exporter-prometheus` | Prometheus scrape endpoint for `/metrics`. | Lane A. |
| **Possibly** `pino-pretty` peer | Already optionally referenced; no production-path change. | None (already a peer). |
| **Possibly** `@opentelemetry/host-metrics` | Host process metrics (CPU/memory). Outside FR-B-001..B-003 scope; **rejected for P4** to keep the surface minimal. | None. |

### 13.2 What MUST NOT be added without separate approval

- `@opentelemetry/auto-instrumentations-node` — rejected as over-broad
  (pulls dozens of instrumentations the platform does not currently use).
- Any managed-vendor SDK (`dd-trace`, `newrelic`, `@honeycombio/...`) —
  rejected by FR-B-007 (vendor neutrality).
- Any pino transport plugin (`pino-loki`, `pino-elasticsearch`, etc.) —
  **separately gated**; not part of P4. The OTel log exporter is the
  intended drain.
- Any new dev-only formatter/lint plugin — reviewer-flagged; not in this
  slice's scope.

### 13.3 T482 validation surface

The future P4 instrumentation PR's reviewer obligation:

1. `git diff package.json packages/shared/package.json apps/api/package.json apps/worker/package.json` — expect deltas restricted to the named two metrics packages and (potentially) a peer-dep bump on `@opentelemetry/api`.
2. `git diff pnpm-lock.yaml` — expect deltas tied to those packages only.
3. **Reject** any PR that bundles a pino-transport plugin or a managed-vendor SDK under cover of T482.

---

## 14. Local operator validation (T483)

### 14.1 The script

```bash
# Start the dev stack
pnpm db:up
pnpm --filter @data-pulse-2/api start:dev  &
API_PID=$!

# Exercise a few real endpoints (auth + tenant-context + audit-emitting flow)
curl -sS -X POST http://localhost:3000/api/v1/auth/signin -d '{...}' -H 'content-type: application/json'
curl -sS http://localhost:3000/api/v1/context/me -H "authorization: Bearer ${TOKEN}"

# Scrape metrics
curl -sS http://localhost:3000/metrics > /tmp/metrics.txt

# Assert every catalogue signal present
for sig in http_request_count http_request_duration_seconds http_error_4xx_total http_error_5xx_total auth_failure_total tenant_context_failure_total validation_failure_total cross_tenant_rejection_total db_pool_in_use db_pool_waiters db_slow_query_total db_rls_context_failure_total db_migration_status; do
  grep -q "^${sig}" /tmp/metrics.txt || { echo "MISSING: ${sig}"; exit 1; }
done

# Assert no PII canary present in metrics OR in the captured pino log
grep -i 'pii-canary@example.test' /tmp/metrics.txt && { echo "LEAK: canary in metrics"; exit 1; }
# (pino log capture is in T462; this step is for ad-hoc operator verification)

kill $API_PID
```

### 14.2 What this proves vs what T460 proves

| Surface | Lane A / T460 (CI) | Lane B / T483 (operator, manual) |
|---|---|---|
| Signal name presence | ✅ in-process supertest | ✅ live `/metrics` scrape |
| PII canary absence in metrics | partial | ✅ explicit grep |
| Log structured fields | (Lane B / T462) | ✅ visual inspection of stdout |
| Real-traffic shape | ❌ unit traffic | ✅ real auth + context + audit flow |

T483 is the **final acceptance gate** before the P4 instrumentation slice
merges. CI cannot fully substitute for it because the supertest harness does
not exercise the full HTTP/Express + middleware stack the operator confirms.

---

## 15. Stop conditions

The P4 redaction-and-cardinality wiring slice STOPS and re-plans if:

1. The redaction matrix is not yet merged. **This lane's wiring inherits the matrix as a precondition.** Without it, T473 has no policy to enforce.
2. T462 PII canary leaks **into** any sink. The slice does not merge until the leak path is closed at the **boundary** (not at the call site).
3. T461 cardinality check finds a forbidden label on any registered signal. The slice does not merge until removal.
4. A pino transport plugin would be required to satisfy the redaction matrix. Pinned-transport changes are **separately gated** under T482; if needed, split the slice.
5. A new call-site redaction pattern (`logger.info({ password: '***' })`) appears in any changed file. Reject at review; the policy is `FR-B-005` non-negotiable.
6. A reviewer cannot run T483 (no local dev env). **Fix**: provide an operator-validation evidence packet (curl/grep output captured in the PR description) before merge; do not skip the validation altogether.

---

## 16. Cross-references to other lanes

| Companion lane | Topic | Interface |
|---|---|---|
| **Lane A — API instrumentation** | Signal-presence (T460), RLS-failure (T463), cross-tenant rejection (T464), auth-failure (T466); emission wiring (T475, T476); metric registration (T470, T471) | This lane (Lane B) is a **consumer** of Lane A's metric helpers — typed signatures enforce forbidden-label discipline. T461 reads from Lane A's registration modules. |
| **Lane C — Worker / queue** | Worker signal-presence (T465), worker metric registration (T472), queue/Redis emission | Same consumer relationship as Lane A. T461 covers worker-side registrations too; T474's `correlation_id` wiring is the worker's responsibility on the worker side. |

This lane's plan stops at the cross-cutting policy boundary. It does not
plan API-specific or worker-specific signal emission.

---

## 17. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A logging library auto-stringifies an exception and embeds raw payload values | MEDIUM | PII leak via error logs | Per-emit-site `err` serializer (matrix §4 row "Worker failure handler") strips frame locals and replaces full message with `error_class` + sanitized summary. T462 canary catches what slips through. |
| Pino `redact` paths use a glob syntax that does not match deep PII paths (`request.body.user.email`) | MEDIUM | PII leak | Explicit `req.body` redaction at the serializer level (replace body wholesale with `{ length }` summary unless an explicit per-route allowlist exempts it). |
| A future contributor adds a new field to a log line that matches a PII class | HIGH | PII leak — eventual | The matrix is the source of truth; reviewer checklist (§5.3) is the immediate guard; T462 canary is the runtime safety net. Three-layer defense. |
| A future P4 PR introduces a metric label that's PII-adjacent but not in the forbidden list (e.g., `customer_segment` from a future analytics feature) | MEDIUM | Unbounded cardinality eventually | T461's allowed-label registry is a *closed* allowlist — anything not registered is forbidden by default, regardless of whether it appears on the explicit forbidden list. **Allowlist over blocklist.** |
| The bootstrap-time assertion fires in production at startup and crashes the API | MEDIUM | Production outage | The assertion runs the same check as the CI test; if the test passes, the assertion does not fire. A green CI = a safe boot. **No fail-open mode.** |
| Existing logger consumers depend on `user_id` and we silently add `actor_id` | LOW | Confusion / drift | Document the dual-name explicitly (§3.2); leave both for the foreseeable future; reviewer notes the redundancy is intentional. |

---

## 18. Mergeability of this PR

**This PR (the Lane B pre-flight) is mergeable as docs-only.** It changes
exactly one file (`docs/observability/p4-redaction-cardinality-plan.md`)
and introduces no:

- runtime code change,
- test file,
- package.json change,
- pnpm-lock.yaml change,
- OpenAPI contract change,
- DB schema or migration change,
- CI workflow change,
- generated file,
- `apps/**` change,
- `packages/**` change,
- `.specify/**` change,
- `loadtests/**` change.

A reviewer can confirm by running `git diff --name-only` against this PR
and expecting **exactly one path**:
`docs/observability/p4-redaction-cardinality-plan.md`.

---

## 19. Recommended commit message (if later approved)

```
docs(observability): pre-flight plan for P4 redaction + cardinality
```

## 20. Recommended PR title (if later approved)

```
docs(observability): pre-flight plan for P4 redaction + cardinality
```

---

## 21. Next action

This plan is the cross-cutting approval gate for the future P4 redaction
and cardinality wiring slice. Recommended sequence:

1. **Now**: review this plan; merge as docs-only after reviewer agreement.
2. **After**: open the gated P4 instrumentation PR (paired with Lane A and
   Lane C), which bundles redaction-serializer wiring (T473), structured-log
   fields (T474), the cardinality static check (T461), the PII-canary test
   (T462), and the package-change validation (T482) into a single coherent
   slice.
3. **After that**: open a separate PR for the operator validation evidence
   packet (T483), or include the evidence in the slice's PR description.

This plan does NOT authorize step 2 or 3. It establishes the policy surface
that those PRs will operate on.

---

*End of Lane B pre-flight plan.*
