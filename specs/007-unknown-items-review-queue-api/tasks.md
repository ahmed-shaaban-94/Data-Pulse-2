---
description: "Task list — 007 Unknown Items Review Queue API"
---

# Tasks: Unknown Items Review Queue — API

**Input**: Design documents from `specs/007-unknown-items-review-queue-api/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/README.md](./contracts/README.md), [quickstart.md](./quickstart.md)
**Tests**: REQUIRED. Constitution §VI mandates test-first (RED → GREEN), Testcontainers-backed isolation, and cross-tenant/cross-store sweeps for every protected endpoint. All implementation tasks pair with a preceding `RED` test task.

---

## 0. TL;DR — 007 is an EXTENSION, not a greenfield build

005 already shipped (contract + runtime on `main`) the list / dismiss / link / create-product operations. 007 adds **inspect**, **reopen**, **bulk-dismiss**, **list-param extensions**, the **`forbidden`** 8th error category, and the **`ReviewQueueItem`** projection (omits `sale_context`). Reused operations get **regression-guard** tasks (assert they still pass under 007's extended suite + projection), NOT reimplementation. See [plan.md §4](./plan.md) for the per-operation shipped/extend/new map.

**⚠️ Shipped-code reality deltas (recorded 2026-05-29 — [research §R7](./research.md), [plan §4.8](./plan.md)). Read before GREEN:**
- **Auth is already wired** on all dashboard routes (the YAML's "auth gap" comment is stale) — new routes follow the wired `DashboardAuthGuard + TenantContextGuard + RolesGuard + @Roles` pattern (R7.1).
- **`sale_context` lives in 5 dashboard wire shapes** — `rowToUnknownItemWireShape` (list + dismiss) AND `rowToWireShape` (link + create-product), plus the new ops. The projection swap (T032 et al.) must cover **all** of them. T002 scope widened to "no dashboard response echoes `sale_context`" (R7.2).
- **POS capture response KEEPS `sale_context`** — provenance round-trip, NOT the review surface. Never touch `toUnknownWireShape` / the `clerkJwt` POS path (R7.3).
- **Reopen 403/404 is service-layer** — `RolesGuard` can't see row scope; the in-scope-403 / out-of-scope-404 split lives in the reopen service, which needs the actor's `isTenantWide` flag (R7.4).
- **Reopen audit is programmatic** — two events (reopen + fresh capture); the static-`@Auditable` route pattern emits one, so reopen injects the audit enqueuer and its test wires the audit providers (R7.5).

---

## 1. Conventions

| Marker | Meaning |
|---|---|
| `[P]` | Parallelizable — different file, no dependency on an incomplete task. |
| `[GATED]` | Approval-gated per Constitution §VIII + Standing Rules §3 — touches a forbidden surface (`packages/contracts/openapi/**`). Listed centrally in §2. Requires explicit owner approval before execution. |
| `[SIGN-OFF]` | Requires a recorded human product decision before execution (the two §4.3 / §4.6 reconciliations). Not a code gate — a decision gate. |
| `[TC]` | Test task (Testcontainers / integration / contract / unit). |
| `[USn]` | Maps to spec.md User Story n. |
| `RED` | Test task that initially fails (no implementation yet). Precedes its `GREEN` pair. |
| `GREEN` | Implementation task that makes a prior `RED` pass; lists the `RED` task as predecessor. |
| `Predecessors:` / `Acceptance:` | Every task states both so a fresh agent can execute it cold. |

All paths are repo-relative. The api app is `apps/api/`; the existing catalog modules are `apps/api/src/catalog/unknown-items/` and `apps/api/src/catalog/reconciliation/`. The GATED contract is `packages/contracts/openapi/catalog/unknown-items.yaml` (shipped v1.1.0-draft).

---

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Why gated |
|---|---|
| `T010 [GATED]` — extend `unknown-items.yaml` (version bump, 3 new operations, `ReviewQueueItem` schema, `forbidden` code, list params) | OpenAPI YAML — `packages/contracts/openapi/**` is a forbidden surface (Constitution §IV/§VIII) |
| `T011 [GATED] [P]` — register/verify the extended YAML in the conformance entrypoint | OpenAPI directory of record |
| `T002 [SIGN-OFF]` — `sale_context` tightening decision (research §R1): *how* (not whether) the shipped list response stops returning `sale_context`. FR-007 is a MUST NOT and the shipped `tenantAdminListUnknownItems` IS the review queue, so leaving `sale_context` on it is a spec violation, not a valid branch. The decision is timing/mechanism (tighten now vs. tighten with a deprecation note on the legacy shape). | Tightening touches a shipped op's response, so the version-bump + sign-off is the *mechanism* for a MUST-mandated leak fix |
| `T003 [SIGN-OFF]` — idempotency-key retrofit decision (research §R6): do shipped link/create/dismiss gain `Idempotency-Key`, or keep the monotonic guard only? | Same — behavior change to live ops |

**Both `[SIGN-OFF]` decisions are now RECORDED (2026-05-29) in [`wave-status.md` § SIGN-OFF Decisions](./wave-status.md) — GREEN is unblocked.**

- **T002 → TIGHTEN (option a, now).** FR-007 is a MUST NOT and the shipped list is the review queue, so the list (shipped + new) stops returning `sale_context` by switching to `ReviewQueueItem` in this slice. Touches 005's shipped response shape → the GATED slice (T010) reconciles 005's conformance tests. ("Leave unchanged" was never a compliant branch — it would ship an FR-007 violation.)
- **T003 → ISOLATE (option b).** Only new reopen/bulk-dismiss carry `Idempotency-Key` (identical-replay-response); shipped link/create/dismiss keep their monotonic-guard no-duplicate-effect — FR-063's two-strength model is satisfied without touching shipped ops. Retrofit is an optional future enhancement, not v1. → key-replay clauses in T060–T062 do NOT apply.

---

## 3. User scenarios → task mapping

| Spec US | Nature | Tasks |
|---|---|---|
| US1 list scoped | **extend** shipped list | T030–T033 (list-param extensions + `ReviewQueueItem`) |
| US2 filter/sort/group/paginate | **extend** shipped list | T034–T037 |
| US3 inspect | **new** | T040–T043 |
| US4 link | **reuse** shipped | T060 regression-guard only |
| US5 create-from | **reuse** shipped | T061 regression-guard only |
| US6 dismiss | **reuse** shipped | T062 regression-guard only |
| US7 reopen | **new** | T050–T054 |
| US8 bulk-dismiss | **new** | T055–T058 |
| US9 failure envelope | **extend** taxonomy (`forbidden`) | T020–T021 (foundational `forbidden`) + T074 (FR-053 determinism) + T075 (FR-054 system-failure retry) + T076 (FR-023/045/SC-003 absence-guard) + asserted in every story's tests |
| US10 idempotency + audit | **extend** (key on new ops) | T052/T056 (reopen/bulk key) + audit asserted per story |

---

## 4. Phase 1 — Setup (shared infrastructure)

- [ ] T001 [P] Confirm the 007 working branch is off latest `origin/main` and the two existing catalog modules compile clean (`apps/api/src/catalog/unknown-items/`, `apps/api/src/catalog/reconciliation/`). Predecessors: none. Acceptance: `pnpm --filter api build` succeeds; both modules present.
- [x] T002 [SIGN-OFF] **DECIDED (2026-05-29): TIGHTEN — option (a), tighten now.** The shipped `tenantAdminListUnknownItems` and all new 007 read ops stop returning `sale_context` (FR-007 MUST NOT; the shipped list IS the review queue) by switching to `ReviewQueueItem` in this slice — not behind a deprecation window. This modifies a 005-shipped response shape: the GATED slice (T010) MUST also update 005's `tenantAdminListUnknownItems` conformance tests and reconcile any consumer asserting `sale_context` presence (`grep -rn "sale_context" apps/api/test/catalog/` before GREEN). Verdict + full rationale recorded in [`wave-status.md` § SIGN-OFF Decisions](./wave-status.md). Predecessors: none. Acceptance: ✅ decision recorded in wave-status.md. This gates T032 / T042.
- [x] T003 [SIGN-OFF] **DECIDED (2026-05-29): ISOLATE — option (b), do not retrofit shipped ops in v1.** Only the new reopen (T053/T054) + bulk-dismiss (T057/T058) carry `Idempotency-Key` (identical-replay-response). The shipped link/create/dismiss keep their monotonic-guard no-duplicate-effect — NOT retrofitted in v1 (recorded as an optional future enhancement). FR-063's two-strength model is satisfied without touching shipped ops. Verdict + rationale in [`wave-status.md` § SIGN-OFF Decisions](./wave-status.md). Predecessors: none. Acceptance: ✅ decision recorded. Consequence: the key-replay clauses in T060–T062 **do NOT apply** (resolved below).

---

## 5. Phase 2 — Foundational (blocking prerequisites for all user stories)

**⚠️ No user-story work begins until Phase 2 is complete.**

### 5.1 GATED contract extension

- [ ] T010 [GATED] Request explicit approval, then extend `packages/contracts/openapi/catalog/unknown-items.yaml`: (1) bump `info.version` from `1.1.0-draft` (additive MINOR per Constitution §IV); (2) add operations `tenantAdminInspectUnknownItem` (GET `/api/v1/catalog/unknown-items/{id}`), `tenantAdminReopenUnknownItem` (POST `/{id}/reopen`), `tenantAdminBulkDismissUnknownItems` (POST `/api/v1/catalog/unknown-items/bulk-dismiss`); (3) add the `ReviewQueueItem` schema = `UnknownItem` minus `sale_context` per [data-model.md §2.1](./data-model.md); (4) add `forbidden` to the error-code vocabulary; (5) add list query params `source_system`, age-bucket, `sort`, `group_by`, and facet output per [contracts/README.md](./contracts/README.md); reuse `cookieAuth`, the cursor/`limit` (max 200/default 50/400-on-out-of-range), and the canonical `Error` envelope. Reopen + bulk-dismiss declare the `Idempotency-Key` header (NOT `Idempotency-Token` — T564 trap, research §R6); mismatch → `idempotency_key_conflict` (409). Predecessors: T001, T010-decisions from T002/T003. Acceptance: YAML lints clean against the existing OpenAPI validator; the 5 shipped operationIds are unchanged (no rename — renames are breaking).
- [ ] T011 [GATED] [P] If the conformance-test entrypoint maintains a YAML registry, confirm `catalog/unknown-items.yaml` remains registered (it already is — this is an in-place extension). Verify during execution; mark complete-no-op if auto-discovered. Predecessors: T010. Acceptance: the extended YAML is discovered by existing conformance tests.

### 5.2 `forbidden` error category (foundational — US9)

- [ ] T020 [P] [TC] RED test — `apps/api/test/catalog/unknown-items/errors/forbidden-category.spec.ts`: assert the API error mapper produces `error.code = "forbidden"` at HTTP `403` for an in-scope insufficient-role case, distinct from `404` not-found, per [FR-051, FR-052, research §R4](./research.md). Predecessors: T001. Acceptance: test runs, fails (no `forbidden` mapping exists yet).
- [ ] T021 GREEN — extend the catalog error mapper (verify the exact file during execution; likely a shared `apps/api/src/catalog/.../error` mapper or the global exception filter) to map the in-scope-authority-failure case to `403 forbidden`, keeping the existing 7 codes unchanged. (Foundational — serves US9 but is a blocking prerequisite for all stories, so no story label.) Predecessors: T020. Acceptance: T020 GREEN; existing 005 error-taxonomy tests still GREEN (regression).

### 5.3 `ReviewQueueItem` projection (foundational — used by US1/US2/US3)

- [ ] T022 [P] [TC] RED test — `apps/api/test/catalog/unknown-items/projection/review-queue-item.spec.ts`: assert a `ReviewQueueItem` projection of an `unknown_items` row carries the [data-model.md §2.1](./data-model.md) field set and **omits `sale_context`** (FR-007 / 006 FR-021a), and applies the FR-001a conditional `resolved_product_id` (present only when the caller may see the product). Predecessors: T001. Acceptance: test runs, fails (no projection helper yet).
- [ ] T023 GREEN — add a **shared** `toReviewQueueItem(row, canSeeProduct)` projection helper in a single home both catalog controllers import (e.g. `apps/api/src/catalog/unknown-items/dto/review-queue-item.dto.ts`) that returns the shipped `UnknownItem` shape **minus `sale_context`**, with FR-001a conditional product-reference suppression. **Per R7.2** this helper replaces BOTH `rowToUnknownItemWireShape` (unknown-items.controller — list + dismiss) AND `rowToWireShape` (reconciliation.controller — link + create-product); make it importable by both, do not duplicate. **Per R7.3** it MUST NOT be used for the POS `toUnknownWireShape` capture response. (Foundational — used by US1/US2/US3 + dismiss/link/create projections, so no single story label.) Predecessors: T022. Acceptance: T022 GREEN.

### 5.4 Isolation-harness extension for the new operations

- [ ] T024 [P] [TC] Extend `apps/api/test/catalog/__support__/seed-unknown-items.ts` (005-owned helper) with fixtures for a `dismissed` row and a `resolved` row across tenants A/B and stores X/Y (for reopen + terminal-detail tests). MUST NOT modify the 003-owned `isolation-harness.ts`. Predecessors: T001. Acceptance: helper exports the new fixtures; existing isolation tests untouched and GREEN.
- [ ] T025 [TC] RED test — `apps/api/test/catalog/unknown-items/isolation/review-queue-sweep.spec.ts` extending the existing cross-tenant/cross-store sweep with cases for inspect/reopen/bulk-dismiss per [SI-001, SI-002, SI-004; FR-060 (authn required), FR-061 (cross-tenant impossible), FR-062 (fail-closed → non-disclosing not-found)](./spec.md): unauthenticated request → 401; cross-tenant id → 404; out-of-scope store id → 404; RLS bypass probe (wrong `app.current_tenant` → zero rows); malicious-override (body `tenant_id`/`store_id` ignored). Predecessors: T024. Acceptance: test runs, cases fail on missing operations (not on RLS).

**Checkpoint**: contract extended + approved, `forbidden` mapped, projection ready, isolation sweep scaffolded. User stories can now proceed.

---

## 6. Phase 3 — US1: Client lists pending items scoped to authority (P1) 🎯 MVP (extend shipped list)

**Goal**: the shipped list returns `ReviewQueueItem` (no `sale_context`) and the FR-001a terminal detail.
**Independent test**: list as tenant-wide vs store-scoped vs cross-tenant; assert scope + no `sale_context` + FR-001a fields ([quickstart.md](./quickstart.md) Journey 1).

- [ ] T030 [P] [US1] [TC] RED — `apps/api/test/catalog/unknown-items/list/list-projection.spec.ts`: list returns `ReviewQueueItem` with **no `sale_context`** key; default is `pending`-only (FR-001, FR-007). Predecessors: T023, T025. Acceptance: test runs, fails (list still returns `sale_context`).
- [ ] T031 [P] [US1] [TC] RED — `apps/api/test/catalog/unknown-items/list/list-terminal-detail.spec.ts`: `?status=dismissed` and `?status=resolved` return the FR-001a / [FR-008] terminal-detail field set, with `resolved_product_id` suppressed when the caller can't see the product. Predecessors: T023, T025. Acceptance: test runs, fails.
- [ ] T032 [US1] [SIGN-OFF-dependent] GREEN — switch the **unknown-items.controller** dashboard responses (`tenantAdminListUnknownItems` AND `tenantAdminDismissUnknownItem` — both use `rowToUnknownItemWireShape`) to the shared `toReviewQueueItem` (T023) so neither returns `sale_context` (FR-007, R7.2). **Timing governed by T002** (decided: tighten now). Leaving `sale_context` is only permitted under a recorded FR-007 waiver (not granted). Predecessors: T030, T031, T002. Acceptance: T030 + T031 GREEN; list + dismiss conformance pass against the version-bumped response shape; `toUnknownWireShape` (POS capture) is untouched (R7.3).
- [ ] T038 [US1] [SIGN-OFF-dependent] GREEN — switch the **reconciliation.controller** dashboard responses (`tenantAdminLinkUnknownItem` AND `tenantAdminCreateProductFromUnknownItem` — both use `rowToWireShape`) to the shared `toReviewQueueItem` (T023) so neither returns `sale_context` (FR-007, R7.2). This is the second half of the T002 tightening the list-focused wording originally missed. Predecessors: T023, T002. Acceptance: link + create-product conformance pass against the version-bumped shape; the regression guards T060/T061 assert no `sale_context` on their responses.
- [ ] T033 [US1] [TC] GREEN-verify — extend the cross-tenant sweep (T025) to exercise the list projection: cross-tenant list → empty page; store-scoped list → only in-scope items, no out-of-scope count/facet leak (SC-001, SC-007). Predecessors: T032. Acceptance: sweep cases GREEN.

**Checkpoint**: list is review-safe (no descriptive metadata leak) and scope-correct.

---

## 7. Phase 4 — US2: Filter / sort / group / paginate safely (P1) (extend shipped list)

**Goal**: add `source_system` / age filter, sort, optional grouping, facets; reuse cursor/`limit` (max 200/reject).
**Independent test**: [quickstart.md](./quickstart.md) Journey 1 #2–#4.

- [ ] T034 [P] [US2] [TC] RED — `list-filters.spec.ts`: filter by `source_system` and age bucket within scope; facets list only in-scope dimensions (FR-002, FR-006, FR-030, FR-033). Predecessors: T032. Acceptance: runs, fails.
- [ ] T035 [P] [US2] [TC] RED — `list-sort-group.spec.ts`: sort by age asc/desc and store; optional `group_by` with no out-of-scope buckets (FR-003, FR-004, FR-032). Predecessors: T032. Acceptance: runs, fails.
- [ ] T036 [P] [US2] [TC] RED — `list-pagination.spec.ts`: `limit` default 50, max 200, out-of-range → `400 validation` (NOT clamp); opaque cursor; total counts only in-scope (FR-005). Predecessors: T032. Acceptance: runs, fails.
- [ ] T037 [US2] GREEN — extend `unknown-items.service.ts` + `unknown-items.controller.ts` list path with the new query params (Zod `.strict()` DTO in `dto/`), scope-safe facet computation, sort, and optional grouping; reuse the shipped cursor/`limit` validation. The list response (and every action op's success response) MUST convey lifecycle state sufficient for a client refresh without a forbidden re-read ([FR-050]). Predecessors: T034, T035, T036. Acceptance: T034–T036 GREEN; shipped list conformance still passes.

**Checkpoint**: queue is navigable at production volume, scope-safe.

---

## 8. Phase 5 — US3: Inspect a single item (P1) (NEW operation)

**Goal**: GET `/{id}` returns `ReviewQueueItem`; out-of-scope/cross-tenant → non-disclosing 404; no candidate hint (v1).
**Independent test**: [quickstart.md](./quickstart.md) Journey 2.

- [ ] T040 [P] [US3] [TC] RED — `inspect/inspect-happy.spec.ts`: in-scope GET `/{id}` → `ReviewQueueItem`, no `sale_context`, no candidate-match hint (FR-009, FR-007, FR-070). Predecessors: T023, T025. Acceptance: runs, fails (no GET-by-id route).
- [ ] T041 [P] [US3] [TC] RED — `inspect/inspect-isolation.spec.ts`: out-of-scope store id → 404; cross-tenant id → 404; both non-disclosing (FR-009, SI-004). Predecessors: T024, T025. Acceptance: runs, fails.
- [ ] T042 [US3] GREEN — add `inspectUnknownItem(id)` to `unknown-items.service.ts` (RLS-scoped single-row read → 404 on zero rows) and the GET `/{id}` route to `unknown-items.controller.ts` mapped to `tenantAdminInspectUnknownItem` (T010), returning `toReviewQueueItem` (T023). Decorate per the existing audit convention if 005 audits inspect; otherwise listing/inspection is not an audited subject (confirm against 005 FR-080 scope during execution). Predecessors: T040, T041, T010, T002. Acceptance: T040 + T041 GREEN; OpenAPI conformance passes for the operationId.
- [ ] T043 [US3] [TC] GREEN-verify — RLS bypass probe for the inspect read (wrong `app.current_tenant` → zero rows → 404). Predecessors: T042. Acceptance: probe GREEN.

**Checkpoint**: inspect is review-safe and non-disclosing.

---

## 9. Phase 6 — US7: Reopen a dismissed item, tenant-wide only (P2) (NEW operation)

**Goal**: reopen creates a fresh `pending` row (005 FR-005); tenant-wide only; `forbidden`/`not-found` split; idempotent.
**Independent test**: [quickstart.md](./quickstart.md) Journey 4.

- [ ] T050 [P] [US7] [TC] RED — `reopen/reopen-happy.spec.ts`: tenant-wide actor reopens a `dismissed` item → fresh `pending` row for the same tuple (005 FR-005), original `dismissed` preserved, both the reopen and the fresh capture audited (FR-041, FR-110). Predecessors: T024, T025. Acceptance: runs, fails.
- [ ] T051 [P] [US7] [TC] RED — `reopen/reopen-authority.spec.ts`: store-operator + in-scope item → `403 forbidden` ("tenant-wide authority required" only); store-operator + out-of-scope item → `404 not-found`; rejection audited (FR-042, FR-111). Predecessors: T024, T025. Acceptance: runs, fails.
- [ ] T052 [P] [US7] [TC] RED — `reopen/reopen-state-and-idempotency.spec.ts`: reopen on `resolved` → `409 already-reconciled` + `details.prior_state=resolved` (FR-043); reopen when a `pending` sibling exists → "already pending", no duplicate (FR-043); same `Idempotency-Key`+body replay → one fresh row, same response; changed body → `idempotency_key_conflict` (FR-063, SC-005). Predecessors: T024, T025. Acceptance: runs, fails.
- [ ] T053 [US7] GREEN — implement `reopenUnknownItem(...)` in `apps/api/src/catalog/reconciliation/reconciliation.service.ts`. **Per R7.4**, the method receives the actor's `isTenantWide` flag (derive from `ctx` role/membership at the controller) — NOT just the id — because the FR-062a split is service-layer: under RLS, zero rows → `404` (non-disclosing); row in-scope AND actor is store-scoped → `403 forbidden` (FR-042); actor tenant-wide → proceed. Then `resolved`→already-reconciled guard, `pending`-sibling→already-pending guard, else INSERT a fresh `pending` row via the 005 FR-005 capture path. **Per R7.5**, emit BOTH audit events programmatically (inject the audit enqueuer): the reopen action AND the fresh capture, within the reopen transaction. Predecessors: T050, T051, T052, T010, T021. Acceptance: T050–T052 GREEN.
- [ ] T054 [US7] GREEN — add the POST `/{id}/reopen` route to `reconciliation.controller.ts` mapped to `tenantAdminReopenUnknownItem` (T010). **Per R7.1/R7.4**, follow the shipped wired pattern: class `@UseGuards(DashboardAuthGuard, TenantContextGuard)` is inherited; add `@UseGuards(RolesGuard)` + `@Roles("owner","tenant_admin","store_manager", { denyAs: 404 })` so a store_manager reaches the service (the 403 is decided there, not at the guard — do NOT use `@Roles("owner","tenant_admin")` which would wrongly 404 in-scope store_managers). `Idempotency-Key` header via the existing interceptor; Zod `.strict()` (empty/`{}` body — no body-supplied tenant/store). Pass `isTenantWide` (derived from `ctx`) into the service call. Audit is emitted by the service (R7.5), NOT a static `@Auditable` on this route. Predecessors: T053. Acceptance: T050–T052 still GREEN; OpenAPI conformance passes.

**Checkpoint**: reopen works, monotonic lifecycle preserved, authority split correct.

---

## 10. Phase 7 — US8: Bulk-dismiss a bounded selection (P2) (NEW operation)

**Goal**: ≤200 ids; whole-batch reject above ceiling; per-item decomposition into shipped dismiss; mixed-success outcomes.
**Independent test**: [quickstart.md](./quickstart.md) Journey 5.

- [ ] T055 [P] [US8] [TC] RED — `bulk-dismiss/bulk-ceiling.spec.ts`: 201 ids → `400 validation`, **nothing dismissed** (FR-044, FR-070, SC-008). Predecessors: T024, T025. Acceptance: runs, fails.
- [ ] T056 [P] [US8] [TC] RED — `bulk-dismiss/bulk-mixed-success.spec.ts`: a ≤200 selection mixing in-scope `pending` / terminal / out-of-scope ids → per-item outcomes (`dismissed` / `already-reconciled`+`details.prior_state` / `not-found`), each success audited, one item's failure not affecting siblings (FR-044, FR-070a, SC-008); same `Idempotency-Key`+body replay is consistent (SC-005). Predecessors: T024, T025. Acceptance: runs, fails.
- [ ] T057 [US8] GREEN — implement `bulkDismissUnknownItems(ids[])` in `unknown-items.service.ts`: enforce the ≤200 ceiling at the batch boundary (reject-whole `validation`), then decompose into N invocations of the **shipped** per-item dismiss path (NOT a new lifecycle write — 006 FR-070a), collecting per-item outcomes. Predecessors: T055, T056, T010. Acceptance: T055 + T056 GREEN.
- [ ] T058 [US8] GREEN — add POST `/bulk-dismiss` route to `unknown-items.controller.ts` mapped to `tenantAdminBulkDismissUnknownItems` (T010), `cookieAuth`, `Idempotency-Key`, Zod `.strict()` `{ ids: string[] }` (`maxItems: 200`). Predecessors: T057. Acceptance: T055 + T056 still GREEN; OpenAPI conformance passes.

**Checkpoint**: bulk-dismiss is a safe UX batching of the shipped dismiss.

---

## 11. Phase 8 — US4/US5/US6: shipped reconciliation (link / create / dismiss) — REGRESSION GUARD ONLY

**Goal**: prove the shipped link/create/dismiss still behave per spec under 007's extended suite + projection; NO reimplementation.

- [ ] T060 [P] [US4] [TC] Regression — `apps/api/test/catalog/reconciliation/link-regression-007.spec.ts`: shipped link still resolves `linked` + audits; `alias_conflict` non-disclosing; race → one winner (FR-020, FR-021, FR-022); **and the link response carries NO `sale_context`** (FR-007, after the T038 projection swap). (T003 = isolate → no `Idempotency-Key` replay assertion; assert monotonic-guard no-duplicate-effect only.) Predecessors: T021, T037, T038. Acceptance: GREEN; link op behavior unchanged except the `sale_context`-free response shape.
- [ ] T061 [P] [US5] [TC] Regression — `create-product-regression-007.spec.ts`: shipped create-from still atomic (product+alias+transition), `alias_conflict` fails closed, missing fields → `validation` (FR-030, FR-031); product creation is always caller-initiated — no silent create path ([FR-065]); **and the create-product response carries NO `sale_context`** (FR-007, after the T038 projection swap). (T003 = isolate → no key-replay assertion; monotonic-guard no-duplicate-effect only.) Predecessors: T021, T037, T038. Acceptance: GREEN; create op behavior unchanged except the `sale_context`-free response shape.
- [ ] T062 [P] [US6] [TC] Regression — `dismiss-regression-007.spec.ts`: shipped dismiss still `pending→dismissed` + audit; re-dismiss → `already-reconciled`+`details.prior_state`; out-of-scope → `404` (FR-040). (T003 = isolate → no key-replay assertion; monotonic-guard no-duplicate-effect only.) Predecessors: T021, T037. Acceptance: GREEN; these are the per-item building block bulk-dismiss decomposes into (T057).

**Checkpoint**: the reused surface is provably intact under 007.

---

## 12. Phase 9 — Polish & cross-cutting

- [ ] T070 [P] [TC] Full audit-linkage sweep — `audit/review-queue-audit.spec.ts`: every state change (reopen, bulk-dismiss item-success) + every audited failure has an event with tenant/store/actor/action/target/correlation-id via 005 FR-083's surface; no parallel channel (SC-004, FR-064, [quickstart.md](./quickstart.md) Journey 6). Predecessors: T054, T058. Acceptance: GREEN.
- [ ] T071 [P] [TC] Run the full quickstart.md journeys 1–6 end-to-end as an integration smoke. Predecessors: all GREEN tasks. Acceptance: all journeys pass.
- [ ] T072 [P] Coverage check — confirm ≥80% line coverage for the new/extended catalog code (Constitution §VI). Predecessors: all GREEN. Acceptance: coverage gate met.
- [ ] T074 [P] [TC] Determinism assertion — `apps/api/test/catalog/unknown-items/errors/determinism.spec.ts` covering [FR-053]: the same logical action against the same authoritative state under the same actor scope MUST yield the identical failure category AND the same non-disclosing wording across repeated calls (e.g., two identical out-of-scope reopen attempts → byte-identical `404` envelope; two identical alias-conflict links → identical `409 alias_conflict` body). Predecessors: T054, T058, T021. Acceptance: GREEN — repeated calls produce identical category + message; no nondeterministic detail (timestamps/ids) leaks into the compared envelope.
- [ ] T075 [P] [TC] System-failure retry-safety — `apps/api/test/catalog/unknown-items/errors/system-failure-retry.spec.ts` covering [FR-054, SC-006]: inject a backend fault mid-action (e.g., a transient DB error on a reopen or bulk-dismiss item) → response is `system-failure`; a retry of the same request either succeeds idempotently (no second lifecycle transition / alias / audit event) or returns the same `system-failure` — never a hidden partial commit. Use the existing fault-injection / transaction-rollback harness if present; verify during execution. Predecessors: T053, T057. Acceptance: GREEN — no partial-commit observable after the faulted+retried action.
- [ ] T076 [P] [TC] Absence-guard — `apps/api/test/catalog/unknown-items/contract/forbidden-operations.spec.ts` covering [FR-023, FR-045, SC-003]: assert the API exposes **no** force-link / override-conflict path and **no** bulk-link / bulk-create / bulk-reopen operation — neither in the extended OpenAPI contract (no such operationId after T010) nor as a routable endpoint (a request to a plausible such route → `404`/`405`, never a success). Predecessors: T010, T037, T054, T058. Acceptance: GREEN — the forbidden surfaces provably do not exist; the contract conformance set contains only the allowed operationIds.
- [ ] T073 Update `wave-status.md` with the final slice status, the two `[SIGN-OFF]` verdicts (T002/T003), and any deferred follow-up. Predecessors: all above. Acceptance: wave-status reflects shipped reality.

---

## 13. Dependencies & execution order

### Phase order
- **Phase 1 Setup** (T001–T003) → no deps; T002/T003 are decision gates.
- **Phase 2 Foundational** (T010–T025) → depends on Setup; **GATED contract (T010) MUST land approved first**, then `forbidden` (T020/T021), projection (T022/T023), isolation scaffold (T024/T025).
- **Phases 3–7** (US1, US2, US3, US7, US8) → depend on Phase 2. US1→US2 are sequential (both touch the list path/file). US3, US7, US8 are independent of each other and of US1/US2 except via the shared foundational helpers.
- **Phase 8** (regression guards) → depend on T021 (forbidden) + T037 (list extended); can run once those land.
- **Phase 9 Polish** → depends on all GREEN.

### Critical path
T001 → T002/T003 (decisions) → **T010 [GATED] approval** → T020/T022/T024 (RED) → T021/T023/T025 → US-story RED/GREEN pairs → T070–T073.

### Parallel opportunities
- T002, T003 (decisions) in parallel.
- Within Phase 2: T020/T022/T024 RED tests in parallel (different files).
- US3 (T040/T041), US7 (T050/T051/T052), US8 (T055/T056) RED tests all parallel.
- US4/US5/US6 regression guards (T060/T061/T062) fully parallel.
- Polish tests T070/T071/T074/T075/T076 are all `[P]` (different files); T074/T075/T076 depend only on the relevant GREEN ops landing.

---

## 14. Implementation strategy

### MVP (US1 + US3)
1. Phase 1 Setup (record both sign-off decisions).
2. Phase 2 Foundational (GATED contract approved + landed; forbidden; projection; isolation scaffold).
3. Phase 3 US1 (review-safe list) + Phase 5 US3 (inspect) — the minimum that makes the queue *readable* without the `sale_context` leak.
4. **STOP & VALIDATE**: list + inspect scope-correct, no descriptive-metadata leak.

### Incremental delivery
- + US2 (filter/sort/group) → queue navigable.
- + US7 (reopen) → dismissal-correction.
- + US8 (bulk-dismiss) → queue-clearing speed.
- US4/US5/US6 regression guards land alongside (no new behavior).

---

## 15. Notes

- **Two human decisions block GREEN**: T002 (`sale_context`) and T003 (idempotency-key retrofit). Default to the conservative `isolate` branch if unrecorded.
- **GATED-first**: the OpenAPI extension (T010) is the source of truth; every new operation's conformance test checks against it, so it must land before the implementing GREEN tasks.
- **Reuse ≠ reimplement**: US4/US5/US6 are regression guards over shipped ops, not new code.
- **T564 trap**: header is `Idempotency-Key`, wire code `idempotency_key_conflict` — never `Idempotency-Token`.
- Commit after each logical RED→GREEN group; never commit/push without explicit instruction (Standing Rules).
- No schema, migration, RLS, or `package.json`/lockfile touch anywhere in this plan — 007 is additive over shipped 003/005.
