# Tenant Isolation Regression Matrix

**Feature**: 001-foundation-auth-tenant-store
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Tasks**: [tasks.md](./tasks.md)
**Constitution**: v3.0.0 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Status**: Documentation only. No tests authored or modified by this artifact.

---

## 1. Purpose & non-goals

This document is the **canonical catalog of tenant-isolation regression
scenarios** that future Testcontainers-backed integration tests MUST cover.
It translates Constitution v3.0.0 Principles **II, IV, VI, XII, XIII** into
named scenario classes (A–J), each with a fixed expected outcome.

**Why a matrix at all.** Tenant isolation is enforced by defense in depth
across guards, repositories, RLS policies, DTOs, and workers. A single
unified catalog prevents drift, enumerates the cross-tenant attack surface
once, and gives every future test PR a place to update its coverage state.

**Non-goals** (explicitly out of scope of this document):

- Authoring or modifying test code. Scenarios describe **what** must be
  tested, not **how** it is implemented.
- Editing [tasks.md](./tasks.md), [spec.md](./spec.md), [plan.md](./plan.md),
  [research.md](./research.md), or any OpenAPI YAML.
- Catalog / sales / POS-event scenarios. The matrix is bounded to the
  13 entities defined in [data-model.md §1–§13](./data-model.md). When
  catalog and POS-event entities ship, a follow-up matrix slice extends
  this file with new scenario classes.
- Pinning test file names beyond what already exists in tasks.md.

**Maintenance contract.** Future test PRs that add or change isolation
behavior MUST update the corresponding scenario row's coverage state.
A scenario row whose expected outcome changes is itself a constitutional
amendment trigger.

---

## 2. Coverage labels

Three states only:

| Label | Meaning | Evidence required |
|---|---|---|
| `covered today` | A test file exists on disk and its scope per [tasks.md](./tasks.md) asserts the scenario. | Path to a real test file. |
| `planned (Tnnn open)` | A dedicated task exists in [tasks.md](./tasks.md), still `[ ]`, no test file on disk yet. | Task ID. |
| `not yet assigned` | No task in [tasks.md](./tasks.md) covers this scenario. Surfaces a gap for a future tasks-amendment slice. | none — flagged as gap. |

A row labelled `covered today` cites only a **file path** (no line
numbers — production code line numbers rot fast). A row labelled
`planned` cites only a **task ID**. A `not yet assigned` row cites
neither and is enumerated in §13 as an open gap.

---

## 3. Principle → scenario-class index

| Constitution principle | Scenario classes |
|---|---|
| II. Multi-Tenant SaaS by Default | A, B, C, D, F, G, H |
| IV. Contract-First POS Integration | J |
| VI. Test-First Quality | (umbrella — every class is a Principle VI obligation) |
| XII. Authorization & Object Safety | B, E, H, I |
| XIII. Auditability & Provenance | F (worker audit emission), and per-class audit-trail expectations |

Every scenario row carries an explicit `Principle` cell so reviewers
can validate the mapping without consulting this index.

---

## 4. Canonical expected envelope

Per Constitution v3.0.0 § "API Conventions", every error response is the
shape:

```json
{ "error": { "code": "...", "message": "...", "request_id": "...", "details": { } } }
```

Status code mapping (from the same constitutional section):

| Status | `code` | When |
|---|---|---|
| 400 | `validation` | Request body / param fails schema validation. |
| 401 | `unauthorized` | No principal, no resolved tenant, no resolvable session/token. |
| 403 | `forbidden` | Active tenant resolved AND user has membership; role gate fails within that tenant. |
| 404 | `not_found` | Cross-tenant lookup; cross-store lookup outside policy; resource genuinely missing. **All three look identical from the outside (FR-ISO-4 / Principle II).** |
| 409 | `conflict` | Uniqueness violation (e.g., store code reused within tenant). |
| 429 | `rate_limited` | Rate limit tripped (e.g., signin attempts). |
| 5xx | `internal` | Unhandled. Never leak internals to the client. |

The "Expected" cells in the matrix below cite **status + code** only.
`request_id` MUST always be present and is not re-asserted per row.

---

## 5. Scenario class A — Tenant context fail-closed

> **Constitution clause (verbatim, Principle II)**: *"RLS MUST fail
> closed. Policies MUST use the safe form
> `current_setting('app.current_tenant', true)::uuid` so that an unset
> GUC yields NULL and matches no rows."*

Scope: behavior when the active tenant context is missing, malformed,
or stale at the guard, middleware, or DB-session layer.

| ID | Scenario | Expected | Principle | Coverage |
|---|---|---|---|---|
| A-1 | Authenticated session with **no `active_tenant_id`** hits a tenant-scoped endpoint. | `401 unauthorized` | II | `covered today` ([apps/api/test/context/tenant-context.guard.spec.ts](apps/api/test/context/tenant-context.guard.spec.ts)) |
| A-2 | Authenticated session, active tenant set, but **user has no active membership** in that tenant (e.g., revoked). | `404 not_found` (per FR-ISO-4 — do not leak that the tenant exists) | II, XII | `covered today` ([apps/api/test/context/tenant-context.guard.spec.ts](apps/api/test/context/tenant-context.guard.spec.ts)) |
| A-3 | DB session begins without `app.current_tenant` GUC set; any tenant-scoped query MUST return zero rows. | empty result set, no error | II | `covered today` ([packages/db/__tests__/middleware/tenant-context.spec.ts](packages/db/__tests__/middleware/tenant-context.spec.ts)) |
| A-4 | `current_setting('app.current_tenant', true)` returns NULL (unset GUC); RLS policy MUST match no rows rather than throw. | empty result set | II | `covered today` ([packages/db/__tests__/middleware/tenant-context.spec.ts](packages/db/__tests__/middleware/tenant-context.spec.ts)) |
| A-5 | Tenant context set on session, but the tenant row is soft-deleted. Subsequent tenant-scoped requests MUST behave as if the tenant does not exist. | `404 not_found` | II, XIV | `not yet assigned` |
| A-6 | Token-based principal whose tenant binding refers to a now-deleted tenant. | empty result set at DB layer (RLS); endpoint surfaces as `404 not_found` | II | `not yet assigned` |

---

## 6. Scenario class B — Cross-tenant resource non-disclosure

> **Constitution clause (verbatim, Principle II)**: *"Cross-tenant
> resource access MUST NOT reveal existence. A request from user A for
> a resource owned by tenant B MUST return the same response shape as
> 'resource does not exist' (default: `404` with the canonical error
> envelope)."*

Scope: every protected resource family. Each resource requires four
test variants: `unauth`, `wrong tenant`, `wrong role within tenant`,
`genuinely missing id`. The first three MUST be indistinguishable in
status + envelope; the fourth MUST also be indistinguishable from
"wrong tenant".

| ID | Resource family | Expected (cross-tenant) | Coverage |
|---|---|---|---|
| B-1 | `GET /api/v1/tenants/{id}` (read another tenant's record) | `404 not_found` | `covered today` ([apps/api/test/tenants/tenants.controller.spec.ts](apps/api/test/tenants/tenants.controller.spec.ts)) |
| B-2 | `PATCH /api/v1/tenants/{id}` (update another tenant) | `404 not_found` | `covered today` ([apps/api/test/tenants/tenants.controller.spec.ts](apps/api/test/tenants/tenants.controller.spec.ts)) |
| B-3 | `DELETE /api/v1/tenants/{id}` (soft-delete another tenant) | `404 not_found` | `not yet assigned` — `DELETE /tenants/{id}` is platform-admin-only, so a non-platform-admin is rejected by `RolesGuard` with `403` before any cross-tenant check; the row's stated `404` outcome is not currently asserted. The cross-tenant non-disclosure scenario as written is degenerate on this endpoint and needs a re-framed test (or removal) in a future tasks-amendment slice. |
| B-4 | `GET /api/v1/stores` (list stores when active tenant is foreign) | empty list OR `401` if no resolvable membership | `not yet assigned` — the "active tenant resolved but foreign to the user" path is rejected by `TenantContextGuard` (membership validation) before any controller path runs, so the controller-level scenario as written is unreachable in the current architecture. The "no active tenant set" sub-case is already covered by A-1; no dedicated controller-level claim of B-4 is currently asserted. |
| B-5 | `GET /api/v1/stores/{id}` (read another tenant's store) | `404 not_found` | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts)) |
| B-6 | `PATCH /api/v1/stores/{id}` (update another tenant's store) | `404 not_found` | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts)) |
| B-7 | `DELETE /api/v1/stores/{id}` (soft-delete another tenant's store) | `404 not_found` | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts)) |
| B-8 | `GET /api/v1/tenants/{id}/members` (list members of another tenant) | `404 not_found` | `covered today` ([apps/api/test/tenants/tenant-members.spec.ts](apps/api/test/tenants/tenant-members.spec.ts)) |
| B-9 | (formerly: `POST /api/v1/tenants/{id}/invitations` — endpoint path was wrong) | n/a | `not yet assigned` — invitation create is exposed as `POST /api/v1/memberships/invite` (server-resolved active tenant; no `{id}` in path), so the cross-tenant-tenant-id scenario as written cannot occur. The cross-tenant `store_ids` in body case IS covered by [invitations.create.spec.ts](apps/api/test/memberships/invitations.create.spec.ts) but that is a class-E mass-assignment scenario, not a class-B non-disclosure scenario. A re-framed B-class scenario for invitation creation needs a future tasks-amendment slice (or this row may be deleted as not applicable). |
| B-10 | `POST /api/v1/invitations/accept` with another tenant's token | `404 not_found` (token hash lookup MUST be tenant-agnostic before tenant binding is established) | `covered today` ([apps/api/test/memberships/invitations.accept-lookup.spec.ts](apps/api/test/memberships/invitations.accept-lookup.spec.ts)) |
| B-11 | `PATCH /api/v1/memberships/{id}` (update another tenant's membership) | `404 not_found` | `covered today` ([apps/api/test/memberships/memberships.patch.spec.ts](apps/api/test/memberships/memberships.patch.spec.ts)) |
| B-12 | `DELETE /api/v1/memberships/{id}` (revoke another tenant's membership) | `404 not_found` | `covered today` ([apps/api/test/memberships/memberships.controller.spec.ts](apps/api/test/memberships/memberships.controller.spec.ts)) |
| B-13 | Whole-API cross-tenant sweep: every protected endpoint × cross-tenant attempt MUST produce indistinguishable `404`. | uniform `404 not_found` envelope | `planned (T203 open)` |
| B-14 | Audit query API (`GET /api/v1/audit/...`) for another tenant's events. | `404 not_found` (no enumeration leak) | `not yet assigned` |

**Principle**: II, XII for every row above.

---

## 7. Scenario class C — Same user, different roles across tenants

> **Constitution clause (verbatim, Principle II)**: *"All ORM/query
> helpers MUST default to tenant-scoped queries..."* + Principle XII:
> *"Default deny."* + spec FR-ROLE-3: *"A user's role applies per
> tenant — the same user may be Tenant Admin in tenant A and Store
> Staff in tenant B."*

Scope: a single user with memberships in two or more tenants. Role and
store-access policy MUST resolve **per active tenant**, never globally.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| C-1 | User U is `tenant_admin` in T1 and `store_staff` in T2. While active in T1, calling a tenant-admin endpoint succeeds. | `2xx` | `not yet assigned` |
| C-2 | Same user, switched to T2, calling the same tenant-admin endpoint. | `403 forbidden` (active tenant resolved; role gate fails) | `not yet assigned` |
| C-3 | Same user switches active tenant T1 → T2; in-flight stale references to T1 resources MUST resolve as `404 not_found` once switch completes. | `404 not_found` for stale T1 ids in T2 context | `planned (T157 open — "active store auto-clears on tenant switch")` partial coverage of the switch flow exists at [apps/api/test/context/auto-clear.spec.ts](apps/api/test/context/auto-clear.spec.ts) for the store-clearing aspect. The cross-tenant reference-staleness aspect is **not yet assigned**. |
| C-4 | User U is platform admin AND has a `store_staff` membership in T1. Active in T1 with platform-admin GUC unset, role gate evaluates as `store_staff`, not `platform_admin`. | role evaluated per active context, no implicit elevation | `not yet assigned` |
| C-5 | Authentication that produces a session does not auto-pick a tenant when user has memberships in multiple tenants (FR-AUTH / scenario 5.1). | session created without `active_tenant_id`; subsequent tenant-scoped call → `401` until context-switch endpoint called | `planned (T152 open)` — `apps/api/test/context/context.controller.spec.ts` exists; specific multi-tenant signin / no-auto-pick assertion has not been content-verified, so the row is conservatively held at `planned` pending a content-read slice. |

**Principle**: II, XII for every row above.

---

## 8. Scenario class D — Cross-store within same tenant

> **Constitution clause (verbatim, Principle II)**: *"Every store-scoped
> operation MUST prove tenant access AND store access before reading or
> mutating data."*

Scope: user U is a member of tenant T with `store_access_kind = 'specific'`
and access to store S1. Behavior toward S2 (same tenant, different store).

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| D-1 | U sets active store to S1 (allowed); request succeeds. | `2xx` | `planned (T152 open)` — `apps/api/test/context/context.controller.spec.ts` exists; specific switch-to-permitted-store assertion has not been content-verified, so the row is conservatively held at `planned` pending a content-read slice. |
| D-2 | U attempts to set active store to S2 via context-switch. | `404 not_found` (store-access policy denies; safe 404) | `covered today` ([apps/api/test/context/tenant-context.guard.spec.ts](apps/api/test/context/tenant-context.guard.spec.ts)) |
| D-3 | U with `kind='specific'` and access only to S1 calls `GET /api/v1/stores/{S2}` directly. | `404 not_found` | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts)) — store-access policy enforced in `StoresService.read` |
| D-4 | A new store S3 is created in tenant T while U has `kind='all'`. U immediately gains read access to S3. | new store visible in `GET /api/v1/stores`; `GET /api/v1/stores/{S3}` succeeds | `planned (T176 open)` |
| D-5 | A new store S3 is created in tenant T while U has `kind='specific'`. U does NOT gain access without an explicit `store_access` row. | `GET /api/v1/stores/{S3}` → `404 not_found` | `planned (T176 open)` |
| D-6 | Removing U's `store_access` row for S1 MUST invalidate cached or in-flight authorization decisions within the documented bound. | subsequent `GET /api/v1/stores/{S1}` → `404 not_found` within the cache-invalidation window | `planned (T177 open)` |
| D-7 | DB-layer invariant I-3 — `store_access` row whose `store.tenant_id` differs from `membership.tenant_id` is rejected by composite FK. | `INSERT` raises FK violation; row never lands. | `covered today` ([packages/db/__tests__/store-access.invariant.spec.ts](packages/db/__tests__/store-access.invariant.spec.ts)) |
| D-8 | Whole-API cross-store sweep: every store-scoped endpoint × wrong-store attempt within same tenant MUST produce indistinguishable `404`. | uniform `404 not_found` envelope | `planned (T204 open)` |

**Principle**: II, XII for every row above.

---

## 9. Scenario class E — Malicious body overrides

> **Constitution clause (verbatim, Principle XII)**: *"Mass-assignment
> is forbidden. `tenant_id`, `store_id`, `role`, `role_id`, `status`,
> `acceptedAt`, `accepted_by_user_id`, `createdBy`, `is_platform_admin`,
> `password_hash`, and any other security-sensitive field MUST NOT be
> assignable from request bodies."*

Scope: the request body attempts to inject a security-sensitive field
that the server resolves from session/token/path context. Server MUST
ignore (preferred) or reject the field, never honor it.

| ID | Sensitive field | Endpoint family | Expected | Coverage |
|---|---|---|---|---|
| E-1 | `tenant_id` in body of `POST /api/v1/stores` | stores create | `400 validation` (Zod `.strict()` rejects unknown key) | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts) — endpoint-level "400 for unknown extra key" assertion exists per task T134; the pipe primitive is also exercised at [apps/api/test/common/zod-validation.pipe.spec.ts](apps/api/test/common/zod-validation.pipe.spec.ts)) |
| E-2 | `tenant_id` in body of `PATCH /api/v1/stores/{id}` (caller hopes to reassign store across tenants) | stores update | `400 validation` (FR-STORE-4 forbids cross-tenant reassign) | `covered today` ([apps/api/test/stores/no-reassign.spec.ts](apps/api/test/stores/no-reassign.spec.ts)) |
| E-3 | `role` / `role_id` in body of membership update by a `store_staff` caller | memberships update | `400 validation` (field not in DTO) OR `403 forbidden` if validated | `not yet assigned` |
| E-4 | `is_platform_admin` in body of any user-mutating endpoint | user (future) / current invitation accept | `400 validation` | `not yet assigned` |
| E-5 | `status='accepted'` + `accepted_by_user_id` in body of invitation accept by an unauthenticated caller | invitations accept | `400 validation` (server resolves from session, not body) | `planned (T172 open — invitation token flow tests)` |
| E-6 | `acceptedAt` in body of invitation accept | invitations accept | `400 validation` | `not yet assigned` |
| E-7 | `createdBy` in body of any create endpoint | stores / memberships / invitations create | `400 validation` | `not yet assigned` |
| E-8 | `password_hash` in body of any user-mutating endpoint | future user endpoints | `400 validation` | `not yet assigned` |
| E-9 | Frontend-bypass probe: `store_staff` user crafts a tenant-admin endpoint request with valid auth cookie. | `403 forbidden` (active tenant resolved; role gate fails) per FR-ROLE-5 | `planned (T205 open)` |

**Principle**: XII for every row above.

---

## 10. Scenario class F — Worker tenant-context expectations

> **Constitution clause (verbatim, Principle V)**: *"Workers that touch
> tenant-owned data MUST set `app.current_tenant` (and where applicable
> `app.is_platform_admin`) inside a transaction. Workers MUST NOT
> operate on tenant data without a resolved tenant context."* +
> Principle II: *"Workers are not exempt."*

Scope: every worker that reads or writes tenant-owned data MUST carry
`tenantId`, `storeId` (when applicable), and `correlationId` in the job
payload, AND establish DB tenant context before touching tenant rows.

| ID | Worker | Touches tenant rows? | Job-payload requirement | Coverage |
|---|---|---|---|---|
| F-1 | Email worker (signin verify, password reset, invitation send) | **No** — email content is rendered from the producer, worker only delivers. JobId carries no PII per producer specs. | `correlationId` only; tenant context not required at DB layer (no DB read). | `documented as N/A (no test required — email worker does not touch tenant rows today)` — not counted toward `covered today`. The existing [email.worker.spec.ts](apps/worker/test/email/email.worker.spec.ts) covers worker mechanics, not a tenant-isolation scenario. If the email worker ever begins reading tenant rows, this row MUST be re-classified and a tenant-context test added. |
| F-2 | `audit-fanout` worker (consumes BullMQ, inserts `audit_events`) | **Yes** — writes to a tenant-scoped table. | `tenantId` (or null for platform-admin events), `correlationId` REQUIRED in payload; worker MUST `SET LOCAL app.current_tenant` (or `app.is_platform_admin`) before INSERT. | `planned (T231, T233 open)` |
| F-3 | `audit-fanout` worker with missing `tenantId` for a tenant-scoped event. | n/a | job MUST be rejected to DLQ with structured failure log; row MUST NOT be inserted under a NULL or default tenant. | `planned (T232 open)` |
| F-4 | `session-revoke` worker | **Yes** — reads/writes `sessions` and `auth_tokens`. | `userId` REQUIRED; worker MUST resolve user → memberships → set per-row tenant context, OR operate as platform admin with explicit GUC. | `planned (T302 open)` |
| F-5 | Soft-delete sweep worker (`soft-delete-sweep.processor.ts`) | **Yes** — scans tenant/store rows past retention. | per-tenant batched; runs as platform admin with `app.is_platform_admin = true`. Documented exception MUST be in the worker's spec. | `planned (T312 open)` |
| F-6 | Audit retention sweep worker | **Yes** — marks audit rows past retention. | platform-admin context; documented exception. | `planned (T311 open)` |
| F-7a | Producer-side: jobId carries no PII (no email, no userId, no raw token). | n/a | redaction enforced at the producer; assertion on jobId composition. | `covered today` ([apps/api/test/auth/email-queue.producer.spec.ts](apps/api/test/auth/email-queue.producer.spec.ts) — explicit "jobId carries no PII" describe block). |
| F-7b | Worker-side: failed-job logs MUST NOT contain tokens, passwords, invitation secrets, payment data, or sensitive PII. | n/a | redaction enforced at the logger boundary, asserted on job-failure log capture. | `not yet assigned` — no dedicated worker-side failed-log redaction test exists today; producer-side is covered by F-7a. |

**Principle**: II, V, XIII for every row above.

---

## 11. Scenario class G — RLS bypass probes

> **Constitution clause (verbatim, Principle II)**: *"The application's
> runtime Postgres role MUST NOT have `BYPASSRLS`. Migrations and
> back-fill scripts may use a separately documented privileged role
> under audited procedures."*

Scope: probes that bypass the application layer entirely and verify
the database-layer guarantees. These are integration tests, not unit
tests.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| G-1 | Open a raw connection with the application role; set `app.current_tenant = T1`; `SELECT * FROM stores WHERE id = '<T2 store id>'`. | zero rows returned | `planned (T207 open)` |
| G-2 | Same probe with `app.current_tenant` **unset** (NULL GUC). | zero rows returned (fail closed via `current_setting(..., true)`) | `planned (T207 open)` |
| G-3 | Same probe with `app.is_platform_admin = 'true'` set explicitly. | rows from any tenant returned (platform-admin path verified) | `planned (T207 open)` |
| G-4 | RLS policies present on every tenant-owned table (data-model.md §16: `users` excluded — not tenant-scoped). | `pg_policies` query returns one or more policies per tenant-owned table. | `covered today` ([packages/db/__tests__/migration.spec.ts](packages/db/__tests__/migration.spec.ts)) |
| G-5 | The application's runtime role does NOT have `BYPASSRLS`. | `SELECT rolbypassrls FROM pg_roles WHERE rolname = '<app role>'` returns false. | `not yet assigned` |
| G-6 | A raw `INSERT` of a `store_access` row with `(membership.tenant_id, store.tenant_id)` mismatch is rejected by composite FK. | constraint violation; row never lands. | `covered today` ([packages/db/__tests__/store-access.invariant.spec.ts](packages/db/__tests__/store-access.invariant.spec.ts)) — covers invariant I-3 at the DB layer. |
| G-7 | DB middleware sets `SET LOCAL` (transaction-scoped, not session-scoped). After the transaction commits/rolls back, the GUC reverts so the next checked-out connection MUST start with NULL `app.current_tenant`. | next probe-without-set returns zero rows | `covered today` ([packages/db/__tests__/middleware/tenant-context.spec.ts](packages/db/__tests__/middleware/tenant-context.spec.ts)) |
| G-8 | ESLint / lint-time forbidding of un-tenant-scoped Drizzle queries in `apps/api/src/**`. | offending query produces a lint error in CI. | `planned (T208 open)` |

**Principle**: II for every row above.

---

## 12. Scenario class H — Safe 404 vs 403 split semantics

> **Constitution clause (verbatim, Principle II)**: *"Cross-tenant
> resource access MUST NOT distinguish 'exists in another tenant' from
> 'does not exist' in the response shape."* + (Principle XII)
> *"Cross-tenant lookups return safe 404; insufficient-role within an
> already-resolved active tenant MAY return 403."*

Scope: the deliberate split between `403` and `404` based on whether
the active tenant is resolved.

| ID | Active tenant resolved? | Role sufficient? | Resource exists in active tenant? | Expected |
|---|---|---|---|---|
| H-1 | No (anonymous or no tenant set) | n/a | n/a | `401 unauthorized` |
| H-2 | Yes | No | Yes (in active tenant) | `403 forbidden` (e.g., `store_staff` calling `POST /api/v1/stores`) — see [apps/api/src/stores/stores.controller.ts](apps/api/src/stores/stores.controller.ts) `@Roles("owner","tenant_admin", { denyAs: 403 })` |
| H-3 | Yes | No | Yes (in active tenant) | `404 not_found` for PATCH/DELETE per `denyAs: 404` default — wrong-role looks like not-found alongside cross-tenant |
| H-4 | Yes | Yes | No (genuinely missing in active tenant) | `404 not_found` |
| H-5 | Yes | n/a | Cross-tenant id | `404 not_found` (indistinguishable from H-3 and H-4) |
| H-6 | Yes (platform admin) | n/a | Anywhere | `2xx` (or genuine `404` if missing) |

| ID | Coverage |
|---|---|
| H-1 through H-5 endpoint matrix | `covered today` for stores/tenants/memberships ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts), [apps/api/test/tenants/tenants.controller.spec.ts](apps/api/test/tenants/tenants.controller.spec.ts), [apps/api/test/memberships/memberships.controller.spec.ts](apps/api/test/memberships/memberships.controller.spec.ts)); whole-API sweep is `planned (T203 open)`. |
| H-6 platform-admin path | `covered today` ([apps/api/test/tenants/tenants.controller.spec.ts](apps/api/test/tenants/tenants.controller.spec.ts) — platform-admin gating asserted per T130). |
| Envelope shape for every status above | `covered today` ([apps/api/test/common/exception.filter.spec.ts](apps/api/test/common/exception.filter.spec.ts), [packages/shared/__tests__/errors/envelope.spec.ts](packages/shared/__tests__/errors/envelope.spec.ts)). |

**Principle**: II, XII.

---

## 13. Scenario class I — Strict DTO/body validation

> **Constitution clause (verbatim, Principle XII)**: *"Strict schema
> validation at the boundary. Request validation MUST reject unknown
> keys (e.g., `Zod.strict()` or equivalent). Silently ignoring unknown
> keys is a regression."*

Scope: every write endpoint MUST reject request bodies that include
unknown keys. The strict-mode pipe is centrally implemented; per-DTO
proof is required for the matrix to be honest.

| ID | Endpoint family | Test requirement | Coverage |
|---|---|---|---|
| I-1 | Endpoint-level strict-body behavior: an unknown key in `POST /api/v1/stores` body triggers `400 validation` envelope. The pipe primitive is also exercised in isolation. | endpoint-level + pipe-level test. | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts) — endpoint-level "400 for unknown extra key" assertion per task T134; pipe-level behavior at [apps/api/test/common/zod-validation.pipe.spec.ts](apps/api/test/common/zod-validation.pipe.spec.ts)) |
| I-2 | `POST /api/v1/tenants` — body with unknown key. | endpoint test. | `not yet assigned` |
| I-3 | `POST /api/v1/stores` — body with unknown key. | endpoint test. | `not yet assigned` |
| I-4 | `PATCH /api/v1/stores/{id}` — body with unknown key. | endpoint test. | `not yet assigned` |
| I-5 | `POST /api/v1/tenants/{id}/invitations` — body with unknown key. | endpoint test. | `not yet assigned` |
| I-6 | `PATCH /api/v1/memberships/{id}` — body with unknown key. | endpoint test. | `not yet assigned` |
| I-7 | `POST /api/v1/invitations/accept` — body with unknown key. | endpoint test. | `not yet assigned` |
| I-8 | Context-switch endpoints (`POST /api/v1/context/tenant`, `POST /api/v1/context/store`) — body with unknown key. | endpoint test. | `not yet assigned` |

**Principle**: XII.

---

## 14. Scenario class J — No raw DB entity in responses

> **Constitution clause (verbatim, Principle IV)**: *"API responses
> MUST NOT return raw database entities. Every response body MUST be
> an explicit wire shape (e.g., a `toBody()` projection), decoupled
> from the underlying schema. Internal-only fields, soft-deletion
> internals, and credential hashes MUST never appear in responses."*

Scope: every JSON response body. The matrix specifies fields that
MUST NOT appear in any response and fields that MUST appear in their
documented form (per the OpenAPI YAMLs in [contracts/](./contracts/)).

| ID | Resource family | Forbidden fields | Coverage |
|---|---|---|---|
| J-1 | Store response (`Store` schema in [stores.openapi.yaml](./contracts/stores.openapi.yaml)) | no internal-only DB columns; no raw timestamps not in YAML; `deleted_at` is allowed and nullable per YAML. | `covered today` ([apps/api/test/stores/stores.controller.spec.ts](apps/api/test/stores/stores.controller.spec.ts) — covers `toBody` projection per task T134); explicit "internal field absent" sweep is `not yet assigned`. |
| J-2 | Tenant response | no `deleted_at` leakage on non-platform-admin reads (soft-deletion internals); no internal counters. | `covered today` ([apps/api/test/tenants/tenants.controller.spec.ts](apps/api/test/tenants/tenants.controller.spec.ts)) partial; explicit forbidden-field sweep is `not yet assigned`. |
| J-3 | Membership response | no `password_hash` (joined user); no `token_hash` of any kind; no internal version columns. | `not yet assigned` |
| J-4 | Invitation response | `token_hash` MUST NEVER appear; raw token visible **only** in the create response on first issuance per FR-AUDIT-3 + Principle XIV. | `planned (T172 open — "token visible once; only hash persisted")` |
| J-5 | Audit event response | no raw payload `metadata` PII; redacted at the emitter, asserted on read-API responses. | `planned (T236 open — PII / credential redaction)` |
| J-6 | Session response (any future endpoint exposing session metadata) | no `id` (cookie value), no `user_agent` to non-admin, no `ip_at_issue` to non-admin. | `not yet assigned` |
| J-7 | Auth token response | the `token_hash` column MUST NEVER be exposed; only the once-on-issuance raw token. | `not yet assigned` |
| J-8 | OpenAPI conformance: every runtime response validates against the YAML it claims to implement. | n/a — validates the contract-conformance task. | `planned (T300 open)` |

**Principle**: IV, XIII for every row above.

---

## 15. Coverage map (summary)

Counts per scenario class after the 2026-05-04 coverage audit.
`covered today` requires both a test file on disk **and** evidence
(content-verified test names or matching task-scope description) that
the file asserts the scenario as written. Rows that fail this bar were
downgraded; rows whose stated scenario is unreachable in the current
architecture were re-classified `not yet assigned`.

A separate **N/A** column captures rows that are documented as not
requiring a test (e.g., a worker that doesn't touch tenant data); they
are not counted toward `covered today`.

| Class | Total | covered today | planned (Tnnn open) | not yet assigned | N/A |
|---|---:|---:|---:|---:|---:|
| A. Tenant context fail-closed | 6 | 4 | 0 | 2 | 0 |
| B. Cross-tenant non-disclosure | 14 | 9 | 1 | 4 | 0 |
| C. Same user, different roles | 5 | 0 | 2 | 3 | 0 |
| D. Cross-store within tenant | 8 | 3 | 5 | 0 | 0 |
| E. Malicious body overrides | 9 | 2 | 2 | 5 | 0 |
| F. Worker tenant-context | 8 | 1 | 5 | 1 | 1 |
| G. RLS bypass probes | 8 | 3 | 4 | 1 | 0 |
| H. Safe 404 vs 403 split | 6 | 6 | 0 | 0 | 0 |
| I. Strict DTO validation | 8 | 1 | 0 | 7 | 0 |
| J. No raw DB entity | 8 | 2 | 3 | 3 | 0 |
| **Total** | **80** | **31** | **22** | **26** | **1** |

(Notes:
- Class F gained one row from the F-7 split into F-7a / F-7b.
- F-1 is the only **N/A** row — the email worker does not touch tenant
  rows today, so a tenant-context test is not required; if that
  changes, F-1 must be re-classified.
- Class H is reported as 6 covered because the four-state matrix
  H-1..H-6 is satisfied at the per-resource level for tenants/stores/
  memberships; the whole-API sweep that promotes coverage to "every
  endpoint" is the `planned (T203 open)` row, accounted for under
  class B.)

---

## 16. Open gaps (`not yet assigned` — candidate Tnnn entries)

Surfaced for a future tasks-amendment slice. **Not edited into
[tasks.md](./tasks.md) by this artifact.**

1. **A-5 / A-6** — soft-deleted-tenant context behavior (active tenant
   referring to a soft-deleted tenant; token referring to a deleted
   tenant).
2. **B-3** — DELETE `/api/v1/tenants/{id}` is platform-admin-only, so
   the cross-tenant non-disclosure scenario as currently written is
   degenerate (non-platform-admin → 403, not 404). Either re-frame the
   scenario to match the platform-admin endpoint semantics or remove
   the row as not applicable.
3. **B-4** — the "GET `/api/v1/stores` list with foreign active tenant"
   path is rejected by `TenantContextGuard` (membership validation)
   before the controller runs. The row's controller-level scenario is
   unreachable in the current architecture; the "no active tenant set"
   sub-case is already covered by A-1. Remove or re-frame the row.
4. **B-9** — the original endpoint path was wrong (`POST /tenants/{id}/
   invitations` does not exist; invitation create is exposed as
   `POST /api/v1/memberships/invite` with active-tenant-resolved
   context). Either remove the row or re-frame as a separate B-class
   scenario for the actual invitation endpoint.
5. **B-14** — audit query API cross-tenant non-disclosure.
6. **C-1, C-2, C-4** — same-user cross-tenant role evaluation matrix
   (multi-tenant role behavior).
7. **C-3 (partial)** — cross-tenant reference staleness on tenant
   switch (the store-clearing aspect is covered today; the resource-
   reference aspect is open).
8. **D-7 confirmed at I-3** — fine; no gap. (Listed for completeness,
   not a real gap.)
9. **E-3, E-4, E-6, E-7, E-8** — per-field mass-assignment override
   tests for `role`/`role_id`, `is_platform_admin`, `acceptedAt`,
   `createdBy`, `password_hash`.
10. **F-7b** — worker-side failed-job-log PII redaction
    (producer-side jobId-no-PII is covered today as F-7a).
11. **G-5** — assertion that the runtime DB role does NOT have
    `BYPASSRLS` (CI-time check).
12. **I-2 through I-8** — per-endpoint unknown-key rejection. The pipe
    is unit-tested AND the stores POST endpoint is covered today via
    I-1; the remaining per-endpoint integration assertions are missing.
13. **J-3, J-6, J-7** — explicit forbidden-field sweep for membership,
    session, and auth-token responses.

These rows are candidates for a future `tasks.md` amendment slice that
adds new Tnnn entries to close them. That slice is **not** in scope
here.

**Note on rows held at `planned (T152 open)` rather than promoted to
`covered today`** (audit conservatism): C-5 and D-1 cite
[apps/api/test/context/context.controller.spec.ts](apps/api/test/context/context.controller.spec.ts)
which exists, but the specific `it()` names that would assert the
scenario as written have not been content-verified. They remain
`planned` until a content-read slice confirms or denies the assertion.

---

## 17. References

- Constitution: [.specify/memory/constitution.md](../../.specify/memory/constitution.md) (v3.0.0). Principles II, IV, V, VI, XII, XIII; sections "API Conventions", "Multi-Tenancy Standards", "Authorization & Object Safety", "Worker & Queue Safety", "Testing Policy".
- Spec: [spec.md](./spec.md) (v3.0.0 referenced). FR-ISO-1..4, FR-CTX-1..6, FR-ROLE-1..5, FR-ACCESS-1..4, FR-AUDIT-1..3, FR-POS-SEAM-1..3.
- Plan: [plan.md](./plan.md) (v3.0.0 referenced). §3.3 tenant-isolation defense in depth.
- Data model: [data-model.md](./data-model.md). §14 RLS pattern, §16 invariant mapping.
- Tasks: [tasks.md](./tasks.md). T130, T134, T152, T157, T172, T176, T177, T203, T204, T205, T207, T208, T231, T232, T233, T236, T300, T302, T311, T312.
- OpenAPI contracts (read-only references): [contracts/](./contracts/) — `auth.openapi.yaml`, `context.openapi.yaml`, `tenants.openapi.yaml`, `stores.openapi.yaml`, `memberships.openapi.yaml`, `audit.openapi.yaml`.

---

**End of regression matrix.**
