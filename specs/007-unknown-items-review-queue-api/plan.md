# Implementation Plan: Unknown Items Review Queue — API

**Branch**: `spec/007-unknown-items-review-queue-api` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-unknown-items-review-queue-api/spec.md`

**Constitution**: v3.0.1 ([.specify/memory/constitution.md](../../.specify/memory/constitution.md))

---

## Summary

007 is an **extension of the already-shipped 005 unknown-items API surface**, not a greenfield API. During planning we discovered that 005 Wave 1 + Wave 2 already shipped, on `main`, both the OpenAPI contract (`packages/contracts/openapi/catalog/unknown-items.yaml`, version `1.1.0-draft`, 5 operationIds) and the runtime controllers/services (`apps/api/src/catalog/unknown-items/` + `apps/api/src/catalog/reconciliation/`). Four of the operations 007's spec lists as "MUST expose" — list, dismiss, link, create-product — **already exist and are live** (the fifth, `posCaptureItem`, is POS-side, owned by 005).

The genuine 007 delta is therefore narrow and coherent:

1. **Inspect operation** (GET `/{id}`) — net-new; no GET-by-id route exists today.
2. **Reopen operation** — net-new; tenant-wide-only authority with the `forbidden`-vs-`not-found` split (006 FR-062a).
3. **Bulk-dismiss operation** — net-new; ≤200-id batch decomposing into per-item dismiss (006 FR-070/FR-070a).
4. **List-parameter extensions** — add `source_system`, age-bucket filter, sort (age/store), optional grouping, and scope-safe filter facets to the shipped `tenantAdminListUnknownItems` (006 FR-030–FR-033).
5. **The `forbidden` failure category** — extend the shipped error taxonomy (005 FR-091's 7 categories) with 006/007's 8th (`forbidden`) for the in-scope reopen authority case.
6. **FR-001a conditional product-reference suppression** — terminal-item detail (resolved/dismissed) with product reference shown only if the caller may see that product.
7. **A v1 review projection that omits `sale_context`** — see the load-bearing reconciliation in §4.3 below.

Technical approach: extend the existing NestJS controllers/services and the existing GATED OpenAPI YAML (version bump), reusing every shipped convention (`cookieAuth`, `tenantAdmin*` operationId naming, cursor pagination, the canonical `Error` envelope, RLS-enforced non-disclosure). No new entity, table, migration, auth model, audit channel, or idempotency primitive.

---

## 1. Technical Context

### 1.1 Stack inheritance — no new decisions

007 inherits the entire stack from 001/003/005 with **zero new technology choices**:

- **Language/Version**: TypeScript 5.x strict, Node.js 20 LTS.
- **Primary Dependencies**: NestJS 11 (api), Drizzle ORM, Zod (runtime validation, `.strict()` at boundary per Constitution §XII).
- **Storage**: PostgreSQL 16+ with RLS. 007 reads/projects over `unknown_items`, `tenant_products`, `product_aliases` (003-owned); it adds no schema.
- **Testing**: Jest + Supertest + Testcontainers; `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs. Isolation harness extended per 006 research §R3 (the 003 T340 pattern, already extended by 005).
- **Target Platform**: Linux server (api process).
- **Project Type**: Web service (backend API) — the dashboard UI that consumes these contracts is a separate future feature.
- **Auth**: dashboard-session `cookieAuth` (component `dp2_session`) — the exact scheme the shipped `tenantAdminListUnknownItems` / `tenantAdminDismissUnknownItem` operations already use. (The spec held this back as HOW per clarify Q3; the plan is the correct altitude to pin it.)
- **Contracts**: OpenAPI 3.1 of record at `packages/contracts/openapi/catalog/unknown-items.yaml` — `[GATED]`.

### 1.2 Inputs from the spec

- 10 user stories (US1–US10), 31 FRs, 11 SI requirements, 9 SCs, 11 edge cases.
- Three clarifications (2026-05-29): candidate-match hint excluded from v1 (FR-070); list page-size max 200 / default 50 / reject-on-out-of-range (FR-005, reconciled to shipped reality during planning); no new per-operation rate limit in v1 (SI-011).

### 1.3 NEEDS CLARIFICATION

**None.** All spec-level ambiguities resolved in `/speckit-clarify`. The two HOW-level items the spec deferred to plan are resolved here:

- **Candidate-match hint**: excluded from v1 (already decided in clarify; plan schedules nothing for it).
- **Wire format**: resolved by *extending the existing contract* rather than authoring fresh — paths, methods, status codes, field names, and the `Error` envelope all follow the shipped `unknown-items.yaml` conventions (§4.4 / §7.3).

### 1.4 Performance Goals

- List/inspect: bounded by the FR-005 page-size ceiling (200). No new latency SLA introduced; the queue MUST NOT threaten 005 SC-002 throughput (SC-001, edge case).
- Bulk-dismiss: ≤200 ids per submission; per-item correctness identical to single dismiss (SC-008).

### 1.5 Constraints

- **Additive-only.** No schema change, migration, RLS amendment, or new auth/audit/idempotency primitive. The OpenAPI YAML edit is the only `[GATED]` touch and lands as its own approved slice.
- **Non-disclosure preserved.** Every new operation enforces RLS-driven 404 for cross-tenant/out-of-scope, except the explicit in-scope reopen `403 forbidden` (Constitution §II/§XII allow `403` for insufficient-role within a resolved tenant).
- **`sale_context` held back in v1** (FR-007 / 006 FR-021a) — see §4.3.

### 1.6 Scale/Scope

- Net-new: 3 operations (inspect, reopen, bulk-dismiss) + list extensions + 1 error category + 1 projection variant.
- Reused unchanged: list/dismiss/link/create-product controllers + services + the `UnknownItem` lifecycle.

---

## 2. Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### 2.1 Initial gate evaluation

| Principle | Relevance | Verdict |
|---|---|---|
| **II. Multi-Tenant RLS** | Every new operation is tenant/store-scoped; cross-tenant + out-of-scope → non-disclosing 404 via RLS, never an auth error. Reopen adds the one allowed `403` (in-scope insufficient-role). | PASS — consumes 005's RLS posture; no bypass. |
| **III. Backend Authority** | Reopen/bulk-dismiss accept no body-supplied tenant/store; ids resolved from session + path. Uniform `Error` envelope reused. Responses are explicit wire shapes (no raw DB rows). | PASS |
| **IV. Contract-First** | OpenAPI YAML stays source of truth; new operationIds (`tenantAdminInspectUnknownItem`, `tenantAdminReopenUnknownItem`, `tenantAdminBulkDismissUnknownItems` — names TBD by the contract slice) are stable + additive; conformance tests required. | PASS — GATED slice. |
| **VI. Test-First** | Integration tests per new operation (happy + auth-failure + cross-tenant + cross-store + insufficient-role + negative); isolation harness extended; RLS bypass probe; malicious-override (body `tenant_id`/`store_id`) tests. | PASS — RED before GREEN. |
| **VII. Observable** | Reuses 005's audit + correlation-id; no new metric required beyond the existing unknown-item / reconciliation-mismatch signals. | PASS |
| **XI. Idempotency** | State-changing ops (reopen, bulk-dismiss) accept the existing `Idempotency-Key` per 001/005; replays converge; mismatch → `idempotency-token-mismatch`. | PASS — consumes existing primitive. |
| **XII. Object Safety** | `.strict()` Zod at boundary; mass-assignment forbidden; object-level authz on every target id; default-deny; safe-404. | PASS |
| **XIII. Auditability** | Every new state change + audited failure emits an event via 005 FR-083's existing surface; no parallel channel. | PASS |
| **XIV. PII Discipline** | `sale_context` (the only advisory/PII-adjacent field) is **held back** by the v1 review projection (§4.3). No new redaction surface. | PASS — but see §4.3 finding. |
| **VIII. Reproducible / GATED** | OpenAPI YAML is `[GATED]`; version bump from `1.1.0-draft`; no `package.json`/lockfile/migration touch. | PASS — gated slice flagged. |

**Initial gate: PASS.** No violation requiring Complexity Tracking.

### 2.2 Post-design re-check

Re-evaluated after Phase 1 (data-model + contracts obligations + quickstart). **Still PASS.** The one item that needed an explicit decision — the `sale_context` projection (§4.3) — resolves *toward* stricter compliance (a review projection that omits the field), not away from it. No new violation introduced by the design.

---

## 3. Architecture Impact Map

### 3.1 Impact classification

**Additive API extension.** Touches: `apps/api/src/catalog/unknown-items/` and `apps/api/src/catalog/reconciliation/` (controllers/services), the GATED `packages/contracts/openapi/catalog/unknown-items.yaml`, and test suites. Does **not** touch: schema, migrations, RLS policies, auth module, audit pipeline, worker, or any other feature's surface.

### 3.2 Triggered review gates

- **GATED contract edit** — `packages/contracts/openapi/catalog/unknown-items.yaml` requires explicit per-slice approval (Constitution §IV/§VIII, Standing Rules §3). Lands as its own slice before the implementing slices' GREEN.
- **Isolation harness extension** — new operations must be added to the cross-tenant/cross-store sweep (Constitution §VI).

### 3.3 New observability signals

**None.** 007 reuses 005's unknown-item-rate and reconciliation-mismatch-rate signals and the existing request/correlation-id logging. No new metric.

---

## 4. 005 Dependency Readiness (the 007 implementability map)

### 4.1 Operation-by-operation: shipped / extend / new

| 007 capability | 005 status on `main` | 007 work |
|---|---|---|
| List pending (FR-001) | **Shipped** — `tenantAdminListUnknownItems`, GET `/api/v1/catalog/unknown-items`, contract + controller + service | **Extend**: add `source_system` / age filter, sort, grouping, facets; swap to the §4.3 projection |
| Dismiss (FR-040) | **Shipped** — `tenantAdminDismissUnknownItem`, POST `/{id}/dismiss` | **Reuse unchanged**; bulk-dismiss decomposes into N of these |
| Link (FR-020) | **Shipped** — `tenantAdminLinkUnknownItem`, POST `/{id}/link` | **Reuse unchanged** |
| Create-from (FR-030) | **Shipped** — `tenantAdminCreateProductFromUnknownItem`, POST `/{id}/create-product` | **Reuse unchanged** |
| Inspect (FR-009) | **Not shipped** — no GET-by-id route | **New**: GET `/api/v1/catalog/unknown-items/{id}` with the §4.3 projection |
| Reopen (FR-041/042/043) | **Not shipped** | **New**: POST `/{id}/reopen`, tenant-wide-only, `forbidden`/`not-found` split, creates fresh `pending` per 005 FR-005 |
| Bulk-dismiss (FR-044) | **Not shipped** | **New**: POST `/bulk-dismiss`, ≤200 ids, per-item outcomes |
| `forbidden` category (FR-051) | **Not in taxonomy** — shipped error codes are 005 FR-091's 7 | **Extend** the error taxonomy with the 8th category |

### 4.2 Capture is POS-side, not a 007 concern

`posCaptureItem` (POST `/api/pos/v1/...`, `clerkJwt`-authenticated) is owned by 005/002 and is out of 007's scope. 007 is the **dashboard-facing** (`cookieAuth`) surface only.

### 4.3 LOAD-BEARING FINDING — the shipped `UnknownItem` schema returns `sale_context`; 007's review surface MUST NOT

The shipped `UnknownItem` projection (contract lines 704–711; runtime `unknown-items.controller.ts:168,225`) **includes `sale_context`** in the response body. But 007 FR-007 + 006 FR-021a require the v1 review surface to surface **no descriptive metadata** — `sale_context` is exactly that. Reusing the shipped projection unchanged would **violate 007's own spec**.

**Resolution (decided here, toward stricter compliance):** 007 defines a **distinct review projection** — call it `ReviewQueueItem` — that is the shipped `UnknownItem` minus `sale_context`, used by the 007 list-extension, inspect, and terminal-detail (FR-001a) responses. The implementing slice MUST NOT echo `sale_context` on any 007 (dashboard review) response.

**Open question deliberately surfaced, not silently absorbed:** is the *existing* shipped `tenantAdminListUnknownItems` already over-disclosing `sale_context` to the dashboard relative to 006 FR-021a's intent? 006 was a docs-only brief that post-dated the 005 contract; the 005 contract framed `sale_context` as "opaque advisory, non-identity," not as "must-not-surface." This is a **pre-existing-surface question** that `/speckit-tasks` should raise as a finding for human decision: either (a) 007's new projection supersedes the list response (tightening it — a behavior change to a shipped op, needs sign-off), or (b) the old list response is left as-is for backward-compat and only the *new* operations use `ReviewQueueItem`. The plan does not unilaterally change a shipped operation's response; it flags the choice.

### 4.4 Wire-format conventions inherited (so the contract slice doesn't reinvent)

- **Auth**: `cookieAuth` (`dp2_session`) for all dashboard operations.
- **operationId**: `tenantAdmin<Verb>UnknownItem(s)` naming.
- **Pagination**: opaque base64url cursor + `limit` (min 1 / max 200 / default 50, 400 on out-of-range) — exactly the shipped `tenantAdminListUnknownItems`.
- **Error envelope**: canonical `{ error: { code, message, request_id } }`; status map per Constitution API Conventions (`400` validation, `401` unauth, `403` in-scope-insufficient-role [reopen only], `404` not-found/cross-tenant, `409` conflict/already-reconciled, `5xx` internal).
- **Idempotency**: `Idempotency-Key` header per the shipped `posCaptureItem` convention, now applied to reopen + bulk-dismiss.
- **No raw DB entities**: explicit wire projection (`ReviewQueueItem`).

### 4.6 SECOND RECONCILIATION — FR-063 idempotency-token vs the shipped mutating ops

Same shape as §4.3. 007 FR-063 (pre-reconciliation) said "**every** state-changing operation MUST accept an idempotency token," and SC-005 wanted identical-replay-response. But the shipped YAML carries `Idempotency-Key` on **`posCaptureItem` only** — the dashboard mutating ops (`tenantAdminDismissUnknownItem` / `...LinkUnknownItem` / `...CreateProductFromUnknownItem`) take no key. They are retry-safe via the monotonic `WHERE resolution_status='pending'` guard, which gives **no-duplicate-effect** but **not identical-replay-response** (first call `200`, retry `409 already_reconciled`).

**Resolution (decided here):** split FR-063/SC-005 into two strengths — *no-duplicate-effect* (all state-changing ops, via the monotonic guard) and *identical-replay-response* (key-bearing ops only: the new reopen + bulk-dismiss carry `Idempotency-Key`; the shipped ops keep the guard). The spec FRs were reworded accordingly.

**Flag for `/speckit-tasks` → human decision:** whether to retrofit `Idempotency-Key` onto the shipped link/create/dismiss ops (a behavior change to live operations, needs sign-off, exactly like §4.3 option (a)). The plan does not retrofit them unilaterally.

**Wire-mapping trap (T564):** the abstract FR-100 category `idempotency-token-mismatch` maps to the **shipped wire code `idempotency_key_conflict`** (`409`), and the header is `Idempotency-Key` (NOT `Idempotency-Token` — 005 recorded the spec/quickstart `Idempotency-Token` drift as known issue **T564**). The 007 contract slice MUST use `Idempotency-Key` + `idempotency_key_conflict` to stay consistent with the shipped surface; do not reintroduce the T564 drift.

### 4.8 Shipped-code reality deltas (recorded 2026-05-29 — see research §R7)

Reading the actual shipped controllers/services (not just the YAML) surfaced four deltas from this plan's assumptions. Full detail in [research §R7](./research.md); summary:

- **R7.1 Auth already wired.** The "documented auth gap" in the YAML/controller comments is stale — `DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard` + `@Roles` are live on all dashboard routes (PRs #377/#378). New 007 routes follow the wired pattern; FR-060 is already satisfied by the inherited stack.
- **R7.2 `sale_context` tightening spans 5 dashboard wire shapes**, not 1: list + dismiss (`rowToUnknownItemWireShape`) AND link + create-product (`rowToWireShape`), plus the new inspect/reopen/bulk-dismiss. T002 scope widened to "no dashboard response echoes `sale_context`." dismiss/link/create were residual leaks the list-focused T002 wording missed.
- **R7.3 POS capture response KEEPS `sale_context`** — it's a provenance round-trip to the POS device (§IX/§XIII), not the reviewer surface FR-007 governs. Tightening touches `cookieAuth` (dashboard) responses only, never `clerkJwt` (POS).
- **R7.4 Reopen's FR-062a 403/404 split is service-layer, not guard-layer.** `RolesGuard` runs before the RLS lookup and can't tell in-scope from out-of-scope; the split (in-scope store_manager → 403, out-of-scope → 404) is enforced in the reopen service, which needs the actor's `isTenantWide` flag — a signature difference from shipped link/dismiss.
- **R7.5 Reopen's dual audit needs programmatic emission.** The static-`@Auditable` route pattern emits one event; US7 #1/FR-110 need two (reopen + fresh capture). Reopen injects the audit enqueuer and emits both; its integration test wires the audit providers the capture test omitted.

### 4.9 TL;DR implementability gate

**007 is fully implementable now.** 005 Waves 1+2 shipped (contract + runtime). The only blocking dependency for the *implementing* slices is the **GATED OpenAPI extension slice**, which must be approved and land first. The R7 deltas refine *how* (service-layer 403/404, programmatic dual-audit, 5-shape projection swap, POS-response exclusion) but do not change *what* the spec requires.

---

## 5. Project Structure

### 5.1 Documentation (this feature)

```text
specs/007-unknown-items-review-queue-api/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (pointer doc — no new schema)
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── README.md        # Phase 1 output — obligations only, no YAML authored here
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### 5.2 Source code (repository root) — additive only

```text
apps/api/src/catalog/
├── unknown-items/                 # EXTEND (shipped)
│   ├── unknown-items.controller.ts   # + GET /{id} (inspect), + GET list params, + bulk-dismiss
│   ├── unknown-items.service.ts      # + inspect, + ReviewQueueItem projection, + bulk decompose
│   └── dto/                           # + inspect/list-param/bulk-dismiss DTOs (Zod .strict())
└── reconciliation/                # EXTEND (shipped)
    ├── reconciliation.controller.ts  # + POST /{id}/reopen
    └── reconciliation.service.ts     # + reopen (fresh-pending per 005 FR-005)

packages/contracts/openapi/catalog/
└── unknown-items.yaml             # [GATED] EXTEND — version bump, new operations, ReviewQueueItem schema, forbidden code

apps/api/test/catalog/             # EXTEND — integration + contract conformance + isolation sweep
```

**Structure Decision**: Extend the two existing catalog modules (`unknown-items`, `reconciliation`) in place rather than create a new `review-queue` module — the operations are the same resources (`unknown_items`) under the same `cookieAuth` dashboard surface, and 005 already split read/dismiss (`unknown-items`) from link/create (`reconciliation`). 007 follows that split: inspect + list-extensions + bulk-dismiss → `unknown-items`; reopen → `reconciliation`.

---

## 6. Phase 0 — Research

See [research.md](./research.md). Resolves: (R1) the `sale_context` projection decision and its pre-existing-surface flag; (R2) reopen's fresh-`pending` mechanism mapped to 005 FR-005 and the `forbidden`/`not-found` authority split; (R3) bulk-dismiss decomposition + the ≤200 ceiling enforcement point; (R4) error-taxonomy extension (`forbidden` as the 8th category); (R5) isolation-harness extension for the new operations; (R6) the idempotency-token vs monotonic-guard reconciliation (FR-063 twin of R1) + the T564 `Idempotency-Key`/`idempotency_key_conflict` wire-mapping trap.

---

## 7. Phase 1 — Design & Contracts

### 7.1 Data model

See [data-model.md](./data-model.md). **No new schema.** Documents the `ReviewQueueItem` projection (`UnknownItem` minus `sale_context`), the FR-001a conditional product-reference field, and the state-transition note for reopen (no lifecycle reversal — fresh `pending` per 005 FR-005).

### 7.2 Quickstart

See [quickstart.md](./quickstart.md). Walks the reviewer-client journeys (list→inspect→link/create/dismiss/reopen, bulk-dismiss) against the extended contract, with the isolation assertions each must satisfy.

### 7.3 Contracts

See [contracts/README.md](./contracts/README.md) — **obligations only**. The canonical YAML at `packages/contracts/openapi/catalog/unknown-items.yaml` is `[GATED]` and is **not authored at plan time**. The README enumerates the new operationIds, the `ReviewQueueItem` schema obligation, the `forbidden` code, and the version bump for the eventual contract slice.

### 7.4 Agent context update

CLAUDE.md's `<!-- SPECKIT START/END -->` markers updated to point to this plan (per the skill's Phase 1 step 3), if present.

---

## 8. Implementation Phasing (advisory — `/speckit-tasks` is next)

1. **GATED contract slice** (first, separate approval): extend `unknown-items.yaml` — bump version, add inspect/reopen/bulk-dismiss operations, `ReviewQueueItem` schema, `forbidden` error code. Resolve the §4.3 pre-existing-surface choice with human sign-off.
2. **RED**: contract-conformance + integration + isolation tests for the new operations (failing).
3. **GREEN**: extend the two controllers/services; wire the `ReviewQueueItem` projection; implement reopen (fresh-`pending`), bulk-dismiss (decompose), inspect, list-param extensions.
4. **Isolation sweep** extension: cross-tenant/cross-store + reopen-authority (`forbidden` vs `not-found`) cases.

This plan does **not** schedule the slices — `/speckit-tasks` does.

---

## 9. Out of Scope (reaffirmed)

- No UI (separate future feature, Impeccable-gated per 006 §11).
- No schema/migration/RLS change; no new auth/audit/idempotency primitive.
- No candidate-match hint in v1 (FR-070).
- No `sale_context` surfacing on any 007 response (FR-007 / §4.3).
- No new per-operation rate limit (SI-011).
- No bulk-link/create/reopen (FR-045).
- No re-implementation of the shipped list/dismiss/link/create-product operations.

---

## 10. Complexity Tracking

> No Constitution violations requiring justification. Table intentionally empty.

---

## Appendix — Files inspected during planning

- `packages/contracts/openapi/catalog/unknown-items.yaml` (shipped 005 contract, v1.1.0-draft, 5 operations)
- `apps/api/src/catalog/unknown-items/{unknown-items.controller.ts, unknown-items.service.ts}` (shipped runtime; `sale_context` in projection at controller:168/225; no GET-by-id)
- `apps/api/src/catalog/reconciliation/reconciliation.controller.ts` (shipped link/create-product; no reopen)
- `specs/005-pos-catalog-sync-reconciliation/{plan.md, data-model.md, contracts/README.md}` (structure precedent)
- `.specify/memory/constitution.md` v3.0.1
- `specs/006-unknown-items-review-queue/spec.md` (product brief)
