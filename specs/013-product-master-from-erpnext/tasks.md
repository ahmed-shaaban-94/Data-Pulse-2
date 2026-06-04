<!--
  /speckit-tasks output for 013 Product Master from ERPNext.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
  Authoring this file (and execution-map.yaml) does NOT authorize the first dispatch — the first slice
  touching packages/db / packages/contracts/openapi / apps/api is a new threshold the owner crosses explicitly.
-->

# Tasks: Product Master from ERPNext

**Feature**: 013-product-master-from-erpnext | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md) | **Mapping concepts**: [mapping-concepts.md](./mapping-concepts.md)

---

## 0. TL;DR — 013 is a tenant↔ERPNext-Item identity-mapping module over the shipped 003 catalogue

013 lets a future sale posting (015) resolve each DP2 sale line to a real ERPNext **Item** (posting decision §1; "fails-to-DLQ if not"). It is a **mapping/reconciliation layer, NOT a catalog-authority handover** (OQ-1, §IX): the 003 Tenant Catalog stays authoritative; ERPNext owns accounting Item identity only. It adds a new `apps/api/src/catalog/erpnext-item-map/` module + the `[GATED]` `erpnext_item_map` table ([data-model.md](./data-model.md)) + a `[GATED]` suggest/confirm review contract. Mapping is **1:1** (OQ-2), **suggest-then-confirm by a Tenant Admin** (OQ-7, human-in-the-loop, no silent auto-trust), **lazy posting-time read, NO import worker** (OQ-8). The posting-time *read* belongs to **015** — `013-RESOLVE` is `proposed`, not dispatchable until 015 exists.

**v1 suggest is MANUAL-ONLY** (owner decision 2026-06-04): a Tenant Admin enters the ERPNext Item ref directly (`suggestion_source = 'manual'`). The `barcode`/`item_code` auto-match values stay in the schema but are **DEFERRED** — they need either an ERPNext item-search op (a future 012 contract extension) or an import (OQ-8 forbids a worker), neither of which exists today. See finding **AUTO_MATCH_NO_SOURCE**.

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [labels] Description (file path). Predecessors: …. Acceptance: ….`
- **Labels**: `[P]` parallelizable; `[GATED]` requires explicit approval (forbidden path); `[TC]` Testcontainers/real-Postgres (run via WSL per `reference_007_test_env`); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test and made GREEN (Constitution §VI). Coverage ≥80%.
- **Auth (CONTRACT)**: the suggest/confirm review surface is a **human Tenant-Admin** action → the **manager/dashboard Clerk-JWT / session** scheme. **NOT** 012's `connectorBearer` (machine) and **NOT** 010's `posDeviceAuth` (device). Pin this explicitly.
- **No worker / no event** (OQ-8): 013 adds no BullMQ queue, no scheduled job. `erpnext.posting.requested` stays **named-only** (012 follow-up-notes) — registering it is **015's** concern, a separate `[GATED]` approval PR. No 013 slice touches `docs/outbox/event-types.md`.
- **No new dependency**: no `package.json` change. Any ERPNext/Frappe client is connector-only + a separate `[GATED]` decision (assumption A-3).

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T010 | `[GATED]` | New OpenAPI suggest/confirm review contract under `packages/contracts/openapi/**` (§IV/§VIII) — explicit approval, its own slice before any implementing GREEN. **Clerk-JWT human auth.** |
| T012 | `[GATED]` | New `erpnext_item_map` Drizzle schema + migration (`packages/db/**`, next number — `0017` indicative) **including RLS + the confirmed-only CHECK + the 1:1 partial-unique** — explicit approval, paired `*.down.sql`, lock-duration review (§VIII). |
| T001 | `[SIGN-OFF]` | Confirm v1 suggest is **manual-only** (`suggestion_source='manual'`); `barcode`/`item_code` auto-match is **deferred** (finding AUTO_MATCH_NO_SOURCE — no ERPNext item-search op in 012; OQ-8 forbids import). If implementation needs auto-match, STOP and raise the 012 item-search extension separately. |
| T002 | `[SIGN-OFF]` | Confirm 013 adds **no worker, no outbox event** (OQ-8); `erpnext.posting.requested` stays unregistered (015). If a posting-time need surfaces, it belongs to 015, not 013. |

## 3. User scenarios → task mapping

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) 🎯 MVP | A Tenant Admin **maps** a tenant product to an ERPNext Item: **suggest (manual) → confirm**, 1:1, confirmed-only, optimistic `version` | T030–T035 |
| US2 (P2) | **Re-point / retire** a mapping (append-only: retire old + new row; never in-place identity rewrite) | T040–T042 |
| (cross-cutting P1) | **Isolation & non-disclosure**: tenant RLS, RLS-bypass probe, cross-tenant 404 on `erpnext_item_map` | T020–T021 |
| (consumer, NOT 013) | **Posting-time resolution** (confirmed-only read; unmapped → DLQ) | T050 — `proposed`, belongs to **015** |
| (polish) | coverage, closeout | T090–T091 |

---

## 4. Phase 1 — Setup

- [ ] T001 [SIGN-OFF] Record the **manual-only v1 suggest** decision (`suggestion_source='manual'`) and the **AUTO_MATCH_NO_SOURCE** finding (no ERPNext item-search op in 012 `posting-feed.yaml`; OQ-8 forbids an import worker — so `barcode`/`item_code` auto-match is deferred). Predecessors: none. Acceptance: decision + finding recorded in [wave-status.md](./wave-status.md); no 012 contract file is in the 013 allowed-files set.
- [ ] T002 [SIGN-OFF] Confirm 013 adds **no worker / no outbox event** (OQ-8); `erpnext.posting.requested` stays unregistered (015's concern). Predecessors: T001. Acceptance: no `apps/worker/**` and no `docs/outbox/event-types.md` in any 013 allowed-files set.
- [ ] T003 [P] Scaffold the new `apps/api/src/catalog/erpnext-item-map/` module (empty `erpnext-item-map.module.ts` registered in `apps/api/src/app.module.ts`, mirroring `reconciliation.module.ts` / `read-down.module.ts`). Predecessors: T002. Acceptance: `pnpm --filter api build` green; module registered; no routes yet; catalog modules still compile (no regression).

## 5. Phase 2 — Foundational (`[GATED]`; block all capability slices)

> Per [data-model.md](./data-model.md): the mapping table + the review contract are both prerequisites for the suggest/confirm CRUD. They touch **disjoint** surfaces (`packages/db/**` vs `packages/contracts/openapi/**`), so they are parallel-safe with each other even though both block the CRUD slice.

### 5.1 `[GATED]` suggest/confirm review OpenAPI contract

- [ ] T010 [GATED] Request explicit approval, then author the suggest/confirm review contract under `packages/contracts/openapi/**`: operations to **list mappings** (incl. unconfirmed), **suggest** (manual — body carries the ERPNext Item ref + `tenant_product_id`; `tenant_id`/actor resolved server-side, never body — §XII), **confirm** (takes the expected `version` for optimistic concurrency → `409` on mismatch — §III), and **retire/re-point**. The **manager/dashboard Clerk-JWT / session** security scheme (NOT `connectorBearer`, NOT `posDeviceAuth`). A `toBody()` projection (no raw DB entity, §IV); canonical Error envelope incl. `409 conflict` (version mismatch) and non-disclosing `404`. Predecessors: T003. Acceptance: YAML lints against the OpenAPI validator; conformance spec authored alongside (operationIds present + globally unique; Clerk-JWT scheme asserted; `409`/`404` in the closed error set; no raw entity).
- [ ] T011 [SIGN-OFF] [P] Confirm no `package.json` dependency is added by the contract/module. Predecessors: T010. Acceptance: conformance harness discovers the new operationIds; no dependency added.

### 5.2 `[GATED]` `erpnext_item_map` schema + migration

- [ ] T012a [P] [TC] RED — schema-shape spec asserting (when the schema exists) `erpnext_item_map` carries the [data-model.md §2](./data-model.md) field set: `tenant_id` NOT NULL FK, `tenant_product_id` NOT NULL FK, `erpnext_item_ref text` (no FK), `state` (`suggested`|`confirmed`), `version int`, suggest/confirm provenance, soft-delete; **fail-closed RLS** `current_setting('app.current_tenant', true)::uuid` (mirror 0010/0014 empty-GUC CASE guard). Predecessors: T003. Acceptance: test runs, fails (no schema yet).
- [ ] T012 [GATED] GREEN — request explicit approval, then author the Drizzle schema (`packages/db/src/schema/catalog/erpnext-item-map.ts`), the barrel re-export, and the paired `00NN_erpnext_item_map.sql` / `.down.sql` migration (next available number — `0017` indicative): the table per [data-model.md §2](./data-model.md) — partial-unique `(tenant_id, tenant_product_id) WHERE retired_at IS NULL` (**1:1**, OQ-2); CHECK pairing `state='confirmed'` with `confirmed_by`/`confirmed_at` (**confirmed-only invariant**, §3); `state`/`suggestion_source` CHECK enums; `version >= 1`; fail-closed RLS (SELECT + write policies on `app.current_tenant`); indexes per data-model §2. **No UOM/price/store column.** Predecessors: T012a, T010-style approval, T001 (manual-only), data-model.md (merged #485). Acceptance: T012a GREEN; migration applies + rolls back clean (UP→DOWN→UP) under Testcontainers; the confirmed-only CHECK rejects a `confirmed` row with NULL `confirmed_by`; the 1:1 partial-unique rejects a 2nd active mapping for the same product; lock-duration reviewed; no change to 003 column semantics.

### 5.3 Isolation-harness extension (blocking — serves all capability slices)

- [ ] T020 [P] [TC] RED — `erpnext_item_map` isolation: a raw-SQL **RLS-bypass probe** (wrong `app.current_tenant` → zero rows), a **cross-tenant sweep** (tenant B cannot read/confirm tenant A's mapping → non-disclosing 404), and a **cross-store assertion** (vacuous — assert the table is correctly tenant-only, no store axis). Predecessors: T012. Acceptance: RED on missing suggest/confirm operations (NOT on RLS); fixtures seed mappings across tenants A/B; probe present.

## 6. Phase 3 — US1 (P1) 🎯 MVP: manual map (suggest → confirm)

- [ ] T030 [P] [TC] [US1] RED — suggest: a Tenant Admin suggests a manual mapping (`tenant_product_id` + `erpnext_item_ref`, `suggestion_source='manual'`); row lands `state='suggested'`, `confirmed_by`/`confirmed_at` NULL; `tenant_id`/actor resolved server-side (body-injected `tenant_id` ignored — §XII). Predecessors: T010, T012, T020. Acceptance: RED (no service yet).
- [ ] T031 [US1] GREEN — `erpnext-item-map.service.ts` + controller `suggest` op (manual); audit-in-transaction; idempotent on `(tenant_id, tenant_product_id)` active. Predecessors: T030. Acceptance: T030 GREEN.
- [ ] T032 [P] [TC] [US1] RED — confirm: confirming a `suggested` row sets `state='confirmed'` + `confirmed_by`/`confirmed_at`; takes expected `version` → **`409` on stale version** (§III optimistic concurrency); a **`suggested` row is NOT resolvable** (confirmed-only invariant — a read for resolution returns "unmapped"). Predecessors: T031. Acceptance: RED.
- [ ] T033 [US1] GREEN — `confirm` op with version-on-update (`WHERE id=$1 AND version=$2`, increment; mismatch → 409); confirmed-only read helper. Predecessors: T032. Acceptance: T032 GREEN; stale-version → 409; suggested row never resolves.
- [ ] T034 [P] [TC] [US1] RED — mass-assignment ban: `state`, `confirmed_by`, `tenant_id`, `version` are NOT body-assignable (§XII strict DTO). Predecessors: T031. Acceptance: RED then GREEN with the command DTO.
- [ ] T035 [US1] GREEN — strict command DTOs (`.strict()`); reject unknown keys; security fields server-resolved only. Predecessors: T034. Acceptance: T034 GREEN.

## 7. Phase 4 — US2 (P2): re-point / retire (append-only)

- [ ] T040 [P] [TC] [US2] RED — re-point: changing the ERPNext Item for a product **retires** the old active row (`retired_at` set) and inserts a NEW row; no in-place identity rewrite; the 1:1 partial-unique holds across the transition. Predecessors: T033. Acceptance: RED.
- [ ] T041 [US2] GREEN — re-point + retire ops (retire old + insert new in one transaction; audit both). Predecessors: T040. Acceptance: T040 GREEN; history preserved (old row retained, retired).
- [ ] T042 [P] [TC] [US2] RED→GREEN — retiring the underlying `tenant_products` row does not orphan/cascade the mapping (FK `restrict`); reconciliation surfaces the dangling case. Predecessors: T041. Acceptance: behavior matches data-model §6.

## 8. Phase 5 — Polish

- [ ] T090 [P] Observability: structured logs carry `tenant_id`/`correlation_id` on suggest/confirm/re-point; no new metric category required (reuses existing). Predecessors: T035, T041. Acceptance: logs present; no secrets/PII.
- [ ] T091 Coverage ≥80% for the new module; closeout (execution-map + wave-status terminal). Predecessors: T090. Acceptance: coverage gate; map/wave-status reconciled.

## 9. Consumer (NOT a 013 slice) — posting-time resolution belongs to 015

- [ ] T050 [PROPOSED — 015] Posting-time resolution: 015 reads the **confirmed** `erpnext_item_map` row lazily when posting a sale line; **unmapped/unconfirmed → fails-to-DLQ** (posting decision §5). **Not dispatchable in 013** — 015 has no spec yet. OQ-5 (sellable-state divergence) and OQ-6 (unknown-items relationship) lock here, with 015. Listed for traceability only.

---

## 10. Findings (carried into the execution map)

- **AUTO_MATCH_NO_SOURCE** (medium) — the data-model's `suggestion_source` enum includes `barcode`/`item_code`, but the 012 `posting-feed.yaml` exposes **only** `connectorPullPostings`/`connectorAckOutcome` — there is **no ERPNext item-search op** DP2→ERPNext, and OQ-8 forbids an import worker. So automated barcode/item_code candidate matching has **no wired source**. **v1 is manual-only** (`suggestion_source='manual'`); auto-match is deferred until either a future `[GATED]` 012 item-search contract extension or a re-opened OQ-8. Affects: T010 (contract scopes to manual), T031 (service). Blocks: nothing in v1 (manual path is complete on its own).
