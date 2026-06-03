<!--
  /speckit-tasks output for 010 POS Catalogue Read-Down Sync.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
-->

# Tasks: POS Catalogue Read-Down Sync

**Feature**: 010-pos-catalog-read-down-sync | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md) | **Contracts**: [contracts/README.md](./contracts/README.md) | **Research**: [research.md](./research.md)

---

## 0. TL;DR — 010 is a READ-ONLY publication module over the shipped 003 catalogue

010 publishes the **Resolved Sellable Store Catalogue** (003 §6.4) to device-authenticated POS terminals as **snapshot + delta**, scoped to `(tenant_id, store_id)` (wire term `branch_id`). It **reuses unchanged** the POS device-principal auth seam (`PosOperatorAuthGuard`, the same guard `posCaptureItem` and the 008 sales POS routes use) and the 003 catalog read path. It adds a new read-only `apps/api/src/catalog/read-down/` module mirroring the `reconciliation/` triad. The two genuinely new `[GATED]` surfaces are the **OpenAPI contract** (`catalog/read-down.yaml`) and the **`0015` catalogue change-log migration** (R1 — backs the cursor + delta + removal-tombstone). The change-log is populated by **DB triggers inside the `0015` migration** (owner decision 2026-06-03), so **no 003/005 application write path is touched** and the read-only Non-Goal (§3) holds. Test-first per Constitution §VI; cross-tenant/cross-store sweep + RLS-bypass probe are mandatory.

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [labels] Description (file path). Predecessors: …. Acceptance: ….`
- **Labels**: `[P]` parallelizable (different files, no incomplete dependency); `[US#]` user-story phase task; `[GATED]` requires explicit approval before running (forbidden path); `[TC]` Testcontainers/real-Postgres integration test (run via WSL per repo convention — see memory `reference_007_test_env`); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test task and made GREEN; RED before GREEN (Constitution §VI). Coverage ≥80%.
- **Money**: `price: { amount: <DecimalAmount string ≤4dp at currency natural minor precision>, currency_code: <ISO-4217> }`; NEVER a float (gate A.6; FR-051; R4). Single currency per `(tenant, store)` for v1.
- **POS routes**: `@Get("api/pos/v1/catalog/...")` with no `@Controller` prefix arg, guarded by `@UseGuards(PosOperatorAuthGuard, …)` (mirror `posCaptureItem` / the 008 sales controller). Read-only — GET only, no write surface (§3, FR — read-down).
- **Scope**: `(tenant_id, store_id)` resolved from the authenticated **device principal** ONLY; `branch_id ≡ store_id` (same uuid, dual-named); body/query scope is untrusted (FR-002/003).

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T010 | `[GATED]` | New OpenAPI read-down contract `packages/contracts/openapi/catalog/read-down.yaml` (sibling to `unknown-items.yaml`) — explicit approval, its own slice before any implementing GREEN (§IV/§VIII). |
| T013 | `[GATED]` | New `0015_pos_catalog_read_down` SQL migration + Drizzle change-log schema (`packages/db/drizzle/`, `packages/db/src/schema/catalog/`) **including the population triggers** — explicit approval, paired `*.down.sql`, lock-duration review (§VIII; R1). |
| T001 | `[SIGN-OFF]` | Confirm the read-down feature stays **read-only**: the change-log is populated by **DB triggers in the `0015` migration**, NOT by instrumenting 003/005 app write paths (owner decision 2026-06-03). The app-level outbox-mirror alternative is **rejected** for v1 (would touch 003/005 writes and strain §3). If implementation finds triggers cannot capture a required transition, STOP and raise a separate `[SIGN-OFF]`/`[GATED]` — do not silently instrument write paths. |
| T011 | `[SIGN-OFF]` | Confirm the read-down module adds **no `package.json` dependency** (cursor codec = base64 of existing ids; money = existing `DecimalAmount` string discipline, no big-decimal lib). If one becomes necessary, STOP and raise a separate `[GATED]` `package.json` request. |

## 3. User scenarios → task mapping

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) 🎯 | Terminal obtains a fresh sellable catalogue **snapshot** (resolved, sellable-only, decimal money, server cursor) | T030–T036 |
| US2 (P2) | Terminal advances its replica via **deltas** (ordered upsert / `remove_from_sellable`, idempotent, `snapshot_required`) | T040–T044 |
| US3 (P1) | **Isolation & non-disclosure** hold for every request (device-auth required, cross-scope non-disclosing 404, scope-bound cursor) | T050–T053 |
| (polish) | Observability aggregation, coverage, closeout | T090–T093 |

> **US3 is cross-cutting (P1).** Its *mechanism* (isolation harness + `PosOperatorAuthGuard` scoping + scope-bound cursor) is foundational; its *phase* is the cross-scope sweep + non-disclosing-404 / device-auth-required / `store_context_required` / foreign-cursor verification — mirroring 008's foundational T015 + per-story verifies.

---

## 4. Phase 1 — Setup (shared infrastructure)

- [ ] T001 [SIGN-OFF] Record the read-only population decision: the catalogue change-log is filled by **DB triggers inside the `0015` migration** (on `tenant_products`, `store_product_overrides`, `product_aliases`), so **no 003/005 application write path is instrumented** and §3 (read-only Non-Goal) holds. Document the rejected app-level outbox-mirror alternative (R1, research) in a one-line note in [data-model.md](./data-model.md) §3. Predecessors: none. Acceptance: decision recorded in data-model §3; no 003/005 source file is in the 010 allowed-files set.
- [ ] T002 [P] Scaffold the new read-only module directory `apps/api/src/catalog/read-down/` (empty `read-down.module.ts` registered in `apps/api/src/app.module.ts`, mirroring `sales.module.ts` / `reconciliation.module.ts`). Predecessors: T001. Acceptance: `pnpm --filter api build` succeeds; module registered; no routes yet.
- [ ] T003 [SIGN-OFF] Confirm the 010 branch is off latest `origin/main` and the catalog modules compile clean (`apps/api/src/catalog/{unknown-items,reconciliation,sales}/`). Predecessors: T002. Acceptance: branch fresh; api build green.

## 5. Phase 2 — Foundational (blocking prerequisites for ALL user stories)

**⚠️ CRITICAL — both `[GATED]` slices block US1 *and* US2.** Per data-model §2/§3 + research R1, the snapshot's opaque cursor (FR-011) **is** the change-log sequence value. There is no spec-compliant snapshot cursor without the change-log. The migration is therefore foundational, not US2-only.

### 5.1 `[GATED]` OpenAPI read-down contract

- [ ] T010 [GATED] Request explicit approval, then author `packages/contracts/openapi/catalog/read-down.yaml` per [contracts/README.md](./contracts/README.md): operations **`posGetCatalogSnapshot`** (`GET /api/pos/v1/catalog/snapshot`) and **`posGetCatalogDeltas`** (`GET /api/pos/v1/catalog/deltas?since=<cursor>`); a dedicated **`posDeviceAuth`** security scheme (device principal, NOT the manager Clerk-JWT scheme); the [data-model §1](./data-model.md) sellable-row `toBody` shape (no raw DB entity, §IV) with `price { amount, currency_code }` decimal-string money; opaque cursor + `next_page_token`; the closed error taxonomy (`snapshot_required`, non-disclosing 404-class, `store_context_required`, standard device-auth failures); JSON+gzip; optional content-hash/ETag (R7). Predecessors: T003. Acceptance: YAML lints clean against the existing OpenAPI validator; registered for conformance tests.
- [ ] T011 [SIGN-OFF] [P] Confirm no `package.json` dependency is added by the contract/module (cursor codec + decimal money use existing primitives). Confirm the new contract is discovered by the conformance-test entrypoint (register in the YAML registry if one exists). Predecessors: T010. Acceptance: conformance harness picks up `posGetCatalogSnapshot` / `posGetCatalogDeltas`; no dependency added.

### 5.2 `[GATED]` catalogue change-log schema + migration (backs cursor + delta + tombstone)

- [ ] T012 [P] [TC] RED test — `apps/api/test/catalog/read-down/schema/change-log-schema-shape.spec.ts`: assert (when the schema exists) a `catalog_change_log` entity carries the [data-model §3](./data-model.md) field set — monotonic `sequence` **per `tenant_id`** (single per-tenant sequence — R9, NOT per-store), `tenant_id` NOT NULL, `store_id` **NULLABLE** (NULL = tenant-wide event), `product_id`, `op` enum (`upsert` | `remove_from_sellable`), `occurred_at` — with **fail-closed RLS** `current_setting('app.current_tenant', true)::uuid` and the empty-GUC CASE guard (mirror 0010/0014). Predecessors: T003. Acceptance: test runs, fails (no schema yet).
- [ ] T013 [GATED] GREEN — request explicit approval, then author the Drizzle schema (`packages/db/src/schema/catalog/catalog-change-log.ts`) and the paired `0015_pos_catalog_read_down.sql` / `0015_pos_catalog_read_down.down.sql` migration: the `catalog_change_log` table with a **single monotonic `sequence` per `tenant_id`** (R9 — NOT per-store), `op` enum, `tenant_id` NOT NULL, **`store_id` NULLABLE** (NULL = tenant-wide event); index `(tenant_id, sequence)` with `store_id` as filter/included column; **fail-closed RLS** on the new table; **dumb population triggers** (R9 — one row per raw change, NO cross-store fan-out, NO `store_product_overrides` consultation) on `tenant_products`, `store_product_overrides`, `product_aliases`: a `tenant_products`/tenant-wide-alias change writes **one `store_id IS NULL`** row; a `store_product_overrides`/store-scoped-alias change writes **one `store_id = S`** row — `upsert` when a sellable-relevant field changes (price, currency, availability/`is_active`, name/alias/tax) or a row crosses INTO the sellable threshold, `remove_from_sellable` when a row crosses OUT (retire / deactivate / price→NULL / currency dropped / non-representable); **the alias-table trigger resolves the parent `product_id`** into the row (resolves analyze U2); NO change to existing 003 column semantics (additive only). Predecessors: T012, T010-style approval, T001 (trigger-population decision), R9 (fan-out decision). Acceptance: T012 GREEN; migration applies + rolls back clean under Testcontainers; triggers fire on the three source tables writing exactly ONE row per raw change with the correct `store_id` NULL/non-NULL; **lock-duration reviewed (R9: worst case is ONE insert per raw UPDATE — no per-store amplification)**.

### 5.3 Isolation-harness extension (blocking — serves all stories, esp. US3)

- [ ] T014 [P] [TC] Extend catalog test support with read-down fixtures (a store with N sellable priced products; an unpriced/missing-currency/non-representable product; a store override changing price/availability; an empty-sellable store) across tenants A/B and stores X/Y, in a new `apps/api/test/catalog/read-down/__support__/seed-read-down.ts`. MUST NOT modify the 003-owned `isolation-harness.ts`. Predecessors: T013. Acceptance: helper exports fixtures; existing isolation tests untouched and GREEN.
- [ ] T015 [TC] RED test — `apps/api/test/catalog/read-down/isolation/read-down-sweep.spec.ts`: cross-tenant/cross-store sweep for snapshot + delta — unauthenticated → 401; **manager Clerk JWT without device principal → rejected** (FR-001); cross-tenant/cross-store `branch_id` not matching token scope → non-disclosing 404-class (FR-002/003/004); foreign `since` cursor presented under another scope → non-disclosing rejection (FR-024); unresolved store context → `store_context_required` (FR-005); **raw-SQL RLS-bypass probe** (wrong `app.current_tenant` ⇒ zero rows) on `catalog_change_log`. Predecessors: T014. Acceptance: test runs, cases fail on missing operations (not on RLS).

**Checkpoint**: Foundation ready — contract pinned, change-log + triggers + cursor mechanism live, isolation harness seeded. US1 and US2 can now begin.

---

## 6. Phase 3 — US1: Terminal obtains a fresh sellable catalogue snapshot (P1) 🎯 MVP

**Goal**: a device-authenticated terminal gets the full resolved **sellable** catalogue for its store (Tenant ⊕ Store Override, sellable-filtered) with the FR-050 payload, decimal money, and a server-issued opaque cursor; unpriced products are absent and recorded as issues.
**Independent test**: authenticate as device principal for `(T, S)`, request the snapshot → exactly the N sellable priced resolved rows, each with required fields + money `{amount, currency_code}` at natural minor precision, a server cursor, paginated if large; zero unpriced rows; the override case reflected field-by-field; the unpriced product produces a signal + backlog entry.

- [ ] T030 [P] [US1] [TC] RED — `apps/api/test/catalog/read-down/snapshot/snapshot-happy.spec.ts`: snapshot for `(T, S)` returns exactly the N sellable priced resolved rows, each carrying the [data-model §1](./data-model.md) fields (revised 2026-06-03, R-1/Option B — real-schema-backed only): `product_id`, `sku`, `name` NOT NULL (single `tenant_products.name`), `aliases[]`, `price{amount,currency_code}`, `tax_category`, `active`, `row_cursor` — and a server-issued opaque cursor (FR-010/011/050/051, SC-001). Assert the removed pharmacy fields (`name_ar`/`name_en`/`controlled_substance`/`prescription_required`/`unit_pack_label`) are NOT present. Predecessors: T013, T015. Acceptance: runs, fails (no route).
- [ ] T031 [P] [US1] [TC] RED — `snapshot/sellable-filter.spec.ts`: a NULL-priced / missing-currency / non-representable-precision product is **absent** from the snapshot AND an unpriced-issue signal (`catalog_unpriced_issue_rate`) + reconciliation-backlog entry is recorded with the correct `reason` enum (FR-013/041/043/044, SC-004/007; R5/R6). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T032 [P] [US1] [TC] RED — `snapshot/resolved-override.spec.ts`: a store override (price/availability/tax) is reflected field-by-field in the resolved row per 003 §5.3; other stores unaffected (FR-010, SC-001; isolation). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T033 [P] [US1] [TC] RED — `snapshot/pagination.spec.ts`: a large catalogue paginates via `next_page_token`, all pages reflect the **same** consistent cursor point; concurrent mutation after that cursor is NOT torn into snapshot pages (FR-012; edge cases). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T034 [P] [US1] [TC] RED — `snapshot/empty.spec.ts`: a store with zero sellable products returns a valid **empty** snapshot at a cursor (not an error) — "synced, empty" distinct from "never synced" (edge case). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T035 [US1] GREEN — implement `posGetCatalogSnapshot` in `apps/api/src/catalog/read-down/read-down.service.ts` + the `@Get("api/pos/v1/catalog/snapshot")` route in `read-down.controller.ts` (mapped to the T010 operationId), guarded by `@UseGuards(PosOperatorAuthGuard, …)` like `posCaptureItem`: resolve `(tenant_id, store_id)` from the device principal (never body); project `Resolved(store) = Tenant ⊕ Store Override` (003 §6.4) via an explicit `toBody()` (no raw DB entity, §IV); apply the sellable filter (R5: active AND price+currency present AND minor-unit-representable); emit decimal-string money at natural minor precision; issue the opaque cursor from the change-log head sequence; paginate via `next_page_token`; emit the unpriced-issue signal + backlog entry for excluded products; emit the FR-080 read-access audit. Predecessors: T030–T034, T010, T013, T011. Acceptance: T030–T034 GREEN; OpenAPI conformance passes for `posGetCatalogSnapshot`.
- [ ] T036 [US1] [TC] GREEN-verify — extend the sweep (T015) for snapshot: cross-tenant/cross-store snapshot request → non-disclosing 404 with **no existence leak via any response/error shape**; RLS-bypass probe on the resolved read path ⇒ zero rows under the wrong tenant (SC-003/004; SI). Predecessors: T035. Acceptance: sweep snapshot cases GREEN.

**Checkpoint**: US1 fully functional — a terminal can build a sellable offline replica with a stored cursor. **This is the MVP and the POS-Pulse 010 unblock** (contract pinned + snapshot reachable, spec §10).

---

## 7. Phase 4 — US2: Terminal advances its replica via deltas (P2)

**Goal**: a terminal at cursor C gets ordered, idempotent, gap-detectable `upsert` / `remove_from_sellable` changes after C, with an advanced cursor; a stale cursor yields `snapshot_required`.
**Independent test**: hold a snapshot at C; add / price-change / retire / make-unpriced; request deltas since C → ordered ops that exactly reconcile the replica; re-request with same C is idempotent; an unservable C returns `snapshot_required`; a foreign-scope cursor is rejected non-disclosingly.

- [ ] T040 [P] [US2] [TC] RED — `apps/api/test/catalog/read-down/delta/delta-upsert.spec.ts`: after an add/price-change post-C, deltas since C return ordered `upsert` ops carrying the new resolved rows + an advanced cursor; applying them reaches the current resolved state (FR-020/022, SC-002). Predecessors: T035. Acceptance: runs, fails.
- [ ] T041 [P] [US2] [TC] RED — `delta/removal-tombstone.spec.ts`: a previously sellable product that is retired OR **becomes** unpriced/missing-currency/non-representable after C emits a `remove_from_sellable` op so the consumer drops it; it NEVER appears active with a NULL/sentinel/manual price; the became-unpriced case also records the unpriced-issue signal + backlog (FR-021/042, Decision #3, SC-004; R5/R6). Predecessors: T035. Acceptance: runs, fails.
- [ ] T042 [P] [US2] [TC] RED — `delta/idempotent-replay.spec.ts`: re-requesting deltas with the **same** `since` cursor yields the same logical change set; applying twice yields the same replica state (FR-021, SC-005; R3). **R9 override-masking case**: a tenant-level change (`tenant_products.default_price`/name) to a field that store S **overrides** still emits a tenant-wide (`store_id IS NULL`) `upsert` in S's delta union, but applying it re-writes S's resolved row to the **same** value (Tenant ⊕ Override, override wins) — a harmless idempotent re-upsert; S's replica is unchanged. Predecessors: T035. Acceptance: runs, fails.
- [ ] T043 [P] [US2] [TC] RED — `delta/snapshot-required.spec.ts`: a cursor older than the retained change-log horizon → `snapshot_required` re-baseline directive; a foreign-scope cursor → non-disclosing rejection (FR-023/024, SC-005). Predecessors: T035. Acceptance: runs, fails.
- [ ] T044 [US2] GREEN — implement `posGetCatalogDeltas` in `read-down.service.ts` + the `@Get("api/pos/v1/catalog/deltas")` route (T010 operationId), same device-auth guard: validate + decode the opaque `since` cursor, reject foreign-scope non-disclosingly (FR-024); read `catalog_change_log` rows with the **R9 union filter** `tenant_id = T AND (store_id = S OR store_id IS NULL) AND sequence > C ORDER BY sequence` (per-tenant sequence is sparse per store — that is correct; completeness is server-guaranteed, not contiguity-checked, FR-022); project `upsert` rows via the same `toBody()` as US1 (resolving Tenant ⊕ Override at read time, so override-masked tenant-wide events become idempotent re-upserts) and emit `remove_from_sellable` tombstones; advance the cursor; return `snapshot_required` when `since` precedes the retained horizon; emit the FR-080 read-access audit. Predecessors: T040–T043, T010, T013. Acceptance: T040–T043 GREEN; conformance passes for `posGetCatalogDeltas`.

**Checkpoint**: US1 + US2 both work independently — terminals can baseline and stay current at per-change cost.

---

## 8. Phase 5 — US3: Isolation & non-disclosure hold for every request (P1)

**Goal**: a terminal can only ever obtain its own `(T, S)` catalogue; device-auth is required; cross-scope reveals nothing; cursors are scope-bound.
**Independent test**: with a principal scoped to `(T, S)`, attempt `(T, S')` / `(T', *)` via any `branch_id`/cursor → non-disclosing 404-class; a manager Clerk JWT alone → rejected; an unresolved store → `store_context_required`.

- [ ] T050 [P] [US3] [TC] RED — `isolation/device-auth-required.spec.ts`: a request authenticated only by a manager Clerk JWT (no device principal) is rejected; an unauthenticated request → 401 (FR-001, US3 sc.2). Predecessors: T035. Acceptance: runs, fails.
- [ ] T051 [P] [US3] [TC] RED — `isolation/scope-mismatch.spec.ts`: a `branch_id` (or query scope) not matching the token scope → non-disclosing 404-class (no exists/not-exists disclosure); a matching `branch_id` serves only `(T, S)` (FR-002/003/004, SC-003, US3 sc.1). Predecessors: T035. Acceptance: runs, fails.
- [ ] T052 [P] [US3] [TC] RED — `isolation/store-context-required.spec.ts`: an unresolved store context → `store_context_required`-class outcome reusing the existing POS error code (FR-005, US3 sc.3). Predecessors: T035. Acceptance: runs, fails.
- [ ] T053 [US3] [TC] GREEN-verify — full cross-tenant/cross-store sweep (T015) GREEN across snapshot + delta; foreign-cursor rejection non-disclosing (FR-024); a raw-SQL **RLS-bypass probe (wrong `app.current_tenant` ⇒ zero rows) on `catalog_change_log`** and the resolved read path; confirm device-principal is the ONLY scope ever served (SC-003, §VI; SI). Predecessors: T044, T050–T052. Acceptance: sweep fully GREEN; RLS probe returns zero rows under the wrong tenant; no cross-scope row ever served.

**Checkpoint**: all three user stories independently functional and isolation-verified.

---

## 9. Phase 6 — Polish & cross-cutting

- [ ] T090 [P] Observability aggregation — confirm the read-down paths emit into the named signals: `catalog_lookup_failure_rate`, the snapshot+delta `reconciliation_mismatch_rate` hook (003 §9), and the new `catalog_unpriced_issue_rate` (R6); no values/names/PII in metric labels; no parallel naming introduced (FR-070). Predecessors: T035, T044. Acceptance: signals present and aggregating; label-hygiene check passes.
- [ ] T091 [P] Performance — set + record server-side snapshot/delta p95 targets measured against a ~50k-product store (the scale POS-Pulse 009 T054 measured); confirm pagination bounds memory at that scale (R8). Predecessors: T035, T044. Acceptance: load-test report recorded (report-only if no perf env, per repo 005/008 precedent).
- [ ] T092 Coverage + full suite — ≥80% on the new `read-down` module; full catalog suite green under WSL Testcontainers. Predecessors: T036, T053. Acceptance: coverage gate met; suite GREEN.
- [ ] T093 Closeout — reconcile `execution-map.yaml` / `wave-status.md` to terminal status with provenance; confirm POS-Pulse 010 unblock conditions (spec §10: contract pinned + snapshot reachable). Predecessors: T092. Acceptance: map reconciled; unblock recorded.

---

## Dependencies & execution order

### Phase dependencies

- **Setup (Ph1)**: no dependencies. T001 records the trigger-population read-only decision; T002 scaffolds the module.
- **Foundational (Ph2)**: depends on Setup; **BLOCKS all user stories**. Within it: T010 (`[GATED]` contract) and T013 (`[GATED]` `0015` change-log migration + triggers) are the hard gates; T014/T015 (isolation harness) depend on T013. **The migration is foundational because the snapshot cursor (FR-011) IS the change-log sequence — US1 cannot satisfy FR-011 without it.**
- **US1 (P1, MVP)**: depends on Foundational. Delivers the snapshot + the POS-Pulse 010 unblock.
- **US2 (P2)**: depends on Foundational; builds on US1's `toBody()` projection (T035) for the upsert rows.
- **US3 (P1, cross-cutting)**: its mechanism is foundational (T015 harness + `PosOperatorAuthGuard` scoping + scope-bound cursor); its verify phase (T050–T053) depends on US1 (T035) and US2 (T044).
- **Polish (Ph6)**: depends on the desired stories being complete.

### `[GATED]` ordering (hard)

T010 (OpenAPI) and T013 (`0015` migration + triggers) each require explicit approval and land as their own slices **before** any GREEN implementing task. T001's `[SIGN-OFF]` (trigger population, read-only) and T011's `[SIGN-OFF]` (no `package.json` dependency) must hold; if either breaks, STOP and raise a separate gated request — never instrument 003/005 write paths or add a dependency silently.

### Parallel opportunities

- Ph2: T010 ∥ T012 (contract vs change-log-schema-shape RED test) until T013 GREEN.
- Within each story: all `[P]`-marked RED tests run in parallel; the single GREEN task per story follows.
- US3's RED tests (T050–T052) are `[P]`; the GREEN-verify (T053) joins after US1+US2 GREEN.

---

## Implementation strategy

- **MVP = US1 (snapshot)** + its Foundational prerequisites (T010, T013, T014, T015). That alone delivers a device-isolated, sellable-filtered, decimal-money snapshot at a server cursor — and **unblocks POS-Pulse 010** (spec §10: contract pinned + snapshot reachable; the consumer's v1 MAY be snapshot-only).
- **Increment**: add US2 (deltas) to keep replicas current at per-change cost, then US3's explicit isolation-sweep verification across both, then polish (observability aggregation, perf, coverage, closeout).
- **Test-first throughout** (Constitution §VI): RED → GREEN per task; cross-tenant/cross-store sweep + RLS-bypass probe are mandatory, not optional.
- **No `[GATED]` artifact runs without approval**: the OpenAPI contract and the `0015` change-log migration (with its population triggers) are separate approval-gated slices. The feature stays read-only — triggers fill the change-log; no 003/005 write path is touched.

---

## Task summary

- **Total**: 22 tasks (T001–T003 setup; T010–T015 foundational incl. 2 `[GATED]` + 2 `[SIGN-OFF]`; T030–T053 the three user stories; T090–T093 polish).
- **Per story**: US1=7 (T030–T036), US2=5 (T040–T044), US3=4 (T050–T053).
- **`[GATED]`**: 2 (T010 OpenAPI, T013 `0015` migration + triggers). **`[SIGN-OFF]`**: 2 (T001 trigger-population read-only, T011 no-dependency).
- **MVP scope**: US1 + Foundational (= the POS-Pulse 010 unblock).
- **Parallel**: all per-story RED tests `[P]`; contract ∥ change-log-schema-shape in Foundational.
- **Tests**: requested (spec §5 mandatory scenarios + Constitution §VI test-first); RED→GREEN `[TC]` Testcontainers via WSL.
