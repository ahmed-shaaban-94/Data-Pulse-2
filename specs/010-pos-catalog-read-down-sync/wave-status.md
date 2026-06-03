# Wave Status — `010-pos-catalog-read-down-sync`

| Field | Value |
| --- | --- |
| Spec | [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Design | [data-model.md](./data-model.md) · [research.md](./research.md) · [contracts/README.md](./contracts/README.md) |
| Execution map | [execution-map.yaml](./execution-map.yaml) |
| Constitution | v3.0.1 |
| Owner | Ahmed Shaaban |
| Updated | 2026-06-03 — **NOT STARTED; design complete, no open blockers.** Planning chain on `main`; `tasks.md` + `execution-map.yaml` + this file on branch `010-pos-catalog-read-down-sync` (off `origin/main`) after `/speckit-tasks` + `/speckit-analyze` + external review + `/speckit-clarify` (**R-1 resolved, Option B**) + research R9 (**R-3 resolved** — per-tenant sequence + sentinel + dumb trigger). **Both `[GATED]` slices unblocked and ready for in-session approval.** F1 (Option-B name collision) fixed. No slice dispatched. |

---

## TL;DR

010 is the platform-side **read-DOWN** catalogue publication API: it serves the **Resolved Sellable Store Catalogue** (003 §6.4) to device-authenticated POS terminals as **snapshot + delta**, scoped to `(tenant_id, store_id)` (wire term `branch_id`). It is the **opposite direction** of 005 (capture-UP) and MUST NOT be conflated with it.

It is **read-only** — the platform stays the catalogue authority (§IX); there is **no write surface**. It reuses unchanged the POS device-principal auth seam (`PosOperatorAuthGuard`, the same guard `posCaptureItem` + the 008 sales POS routes use) and the 003 catalog read path, adding a new read-only `apps/api/src/catalog/read-down/` module mirroring the `reconciliation/` triad.

The two genuinely new `[GATED]` surfaces are the **OpenAPI contract** (`packages/contracts/openapi/catalog/read-down.yaml`) and the **`0015` catalogue change-log migration** (backs the cursor + delta + removal tombstone, research R1). The change-log is **populated by DB triggers inside the `0015` migration** (owner decision 2026-06-03) on `tenant_products` / `store_product_overrides` / `product_aliases`, so **no 003/005 application write path is touched** and the read-only Non-Goal (§3) holds. The app-level outbox-mirror is the **rejected** alternative.

**MVP** = `010-US1-SNAPSHOT` + its foundational prerequisites (`010-CONTRACT`, `010-SCHEMA`, `010-ISOLATION-HARNESS`). It delivers a device-isolated, sellable-filtered, decimal-money snapshot at a server cursor — and **unblocks POS-Pulse `010-terminal-catalogue-read-sync`** (separate repo; spec §10: contract pinned + snapshot reachable; the consumer's v1 MAY be snapshot-only).

---

## Critical design coupling (why the migration is foundational)

The snapshot's opaque cursor (**FR-011**) **IS** the change-log sequence value (data-model §2/§3, research R1). There is no spec-compliant snapshot cursor without the change-log. The `0015` migration therefore blocks **US1 *and* US2** — it is **foundational, not US2-only**. A naive "snapshot=US1 needs only the read; delta=US2 needs the change-log" mapping is wrong and was explicitly avoided in `tasks.md` and the execution map.

---

## Dependency & parallel-safety graph

```text
                 010-SIGNOFF-READONLY  (T001, [SIGN-OFF] — change-log via DB triggers, read-only; outbox-mirror rejected)
                                   │
                                   ▼
                              010-SETUP  (T002/T003 — new read-down module skeleton + app.module wiring)
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                     ▼
   010-CONTRACT [GATED]                     010-SCHEMA [GATED]
   (T010/T011 — OpenAPI read-down contract)  (T012/T013 — 0015 change-log migration + triggers)
   packages/contracts/openapi/catalog/**     packages/db/**  (+ depends on SIGNOFF-READONLY)
   approval_required: true                   approval_required: true
   blocks US1 + US2 (the routes)             blocks ISOLATION-HARNESS + US1 + US2
                 │                            (FOUNDATIONAL: snapshot cursor IS the change-log sequence)
                 │                                     │
                 │                                     ▼
                 │                          010-ISOLATION-HARNESS (T014/T015 — seed + sweep RED)
                 │                                     │
                 └──────────────┬──────────────────────┘
                                ▼
            ┌──────────── 010-US1-SNAPSHOT (T030–T036) 🎯 MVP ────────────┐
            │   the FIRST GREEN; creates read-down.controller/service      │
            │   + toBody() projection. = the POS-Pulse 010 unblock.        │
            └──────────────────────────┬──────────────────────────────────┘
                                        │  (US2 + US3 SHARE read-down.controller/service → SERIALIZE)
                                        ▼
                          010-US2-DELTA (T040–T044)
                          ordered upsert / remove_from_sellable, idempotent, snapshot_required
                                        │
                                        ▼
                          010-US3-ISOLATION (T050–T053)   ← device-auth-required + cross-scope sweep + RLS probe
                                        │
                                        ▼
                          010-POLISH (T090–T092)   observability signals + ≥80% coverage + report-only perf
                                        │
                                        ▼
                          010-CLOSEOUT (T093)   reconcile map + wave-status to terminal
```

### Parallel-safe groups (proposed, awaiting endorsement)

| Group | Members | Why safe |
| --- | --- | --- |
| **GATED-FOUNDATIONAL** | `010-CONTRACT`, `010-SCHEMA` | Distinct surfaces (OpenAPI YAML vs `packages/db` schema+migration+triggers). Both `[GATED]`, order-independent between themselves. (`010-SCHEMA` also waits on `010-SIGNOFF-READONLY`.) |

### NOT parallel-safe (must serialize) — the load-bearing caution

`010-US1-SNAPSHOT`, `010-US2-DELTA`, and `010-US3-ISOLATION` are **conceptually independent** but US1 + US2 write the **same two files** — `apps/api/src/catalog/read-down/read-down.controller.ts` and `read-down.service.ts`. They are therefore **NOT file-parallel-safe** and MUST serialize through the shared module (exactly like 008 US1–US6). US3 + POLISH are test/metrics-only and land after the routes exist.

**No worker slice** — 010 is read-only; there is no off-request processing (unlike 008's `008-WORKER`).

---

## Slice status

| Slice | Tasks | Type | Gate | Status | PR | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 010-SIGNOFF-READONLY | T001 | docs | `[SIGN-OFF]` | not_started | — | DB-trigger population, read-only; record decision in data-model §3 |
| 010-SETUP | T002, T003 | chore | — | not_started | — | empty read-down module + app.module wiring |
| 010-CONTRACT | T010, T011 | feat | `[GATED]` | not_started | — | `catalog/read-down.yaml` + `posDeviceAuth`; T011 [SIGN-OFF] no-dep. **R-1 RESOLVED (Option B) — payload now real-schema-backed; ready for approval** |
| 010-SCHEMA | T012, T013 | feat | `[GATED]` | not_started | — | `0015` change-log + triggers; FOUNDATIONAL (cursor=sequence). **R-3 RESOLVED (R9: per-tenant seq + sentinel + dumb trigger) — ready for approval** |
| 010-ISOLATION-HARNESS | T014, T015 | test | — | not_started | — | seed across A/B × X/Y + sweep RED |
| 010-US1-SNAPSHOT 🎯 | T030–T036 | feat | — | not_started | — | MVP; first GREEN; POS-Pulse 010 unblock |
| 010-US2-DELTA | T040–T044 | feat | — | not_started | — | shares controller/service → serialize |
| 010-US3-ISOLATION | T050–T053 | test | — | not_started | — | device-auth + cross-scope sweep + RLS probe |
| 010-POLISH | T090–T092 | chore | — | not_started | — | signals + coverage + report-only perf |
| 010-CLOSEOUT | T093 | docs | — | not_started | — | terminal reconciliation |

**Totals**: 10 slices · 22 tasks (T001–T093) · 2 `[GATED]` (CONTRACT, SCHEMA) · 2 `[SIGN-OFF]` (T001 read-only, T011 no-dep).

---

## Active findings

> ✅ **R-1 RESOLVED** (2026-06-03, `/speckit-clarify` Option B) — `010-CONTRACT` unblocked. ✅ **R-3 RESOLVED** (2026-06-03, research R9 — per-tenant sequence + sentinel + dumb trigger) — `010-SCHEMA` unblocked. **Both `[GATED]` slices are now design-complete and ready for in-session approval.** The external code-grounded review found the payload/schema contradiction (R-1) and the trigger fan-out gap (R-3) that `/speckit-analyze`'s internal pass could not see; both are now reconciled across spec + research + data-model + tasks + contracts + execution-map.

### External review findings (verified against live code)

- **R-1 — ✅ RESOLVED 2026-06-03 (`/speckit-clarify`, Option B).** FR-050 originally required `name_ar`/`name_en`, `controlled_substance`, `prescription_required`, `unit_pack_label` — none backed by a catalog column (§I violation: legacy/pharmacy fields not re-grounded). **Resolution: revise the payload DOWN to real-schema-backed fields only** — emit single `name` (drop ar/en split), drop the three pharmacy flags + `unit_pack_label`; retain `product_id`, `sku`, `aliases[]`, `price{amount,currency_code}`, `tax_category`, `active`, `row_cursor` (all verified-backed). 010 stays read-only + schema-free; POS-Pulse 010 loses Arabic-name + pharmacy-flag display in v1 (re-adding = future spec that first adds the 003 column). **Propagated to** spec.md (Clarifications §2026-06-03 + FR-050 + Key Entities + §8), data-model.md §1, tasks.md T030, contracts/README.md. **`010-CONTRACT` is now UNBLOCKED.**
- **R-2 — ✅ RESOLVED (consequence of R-1).** The spec is now internally consistent: full payload ⟶ real-schema-backed payload reconciles (a)/(b)/(c). §8 now explicitly states every emitted field maps to an existing 003 column.
- **R-3 — ✅ RESOLVED 2026-06-03 (research R9).** Decision: **single monotonic `sequence` per `tenant_id`** (not per-store) + **tenant-wide `store_id IS NULL` sentinel rows**; a **dumb trigger** writes exactly ONE change-log row per raw catalog change (no cross-store fan-out, no `store_product_overrides` consultation). Delta read unions `(store_id = S OR store_id IS NULL)`. **Override-masking gap** (a tenant-level change to a field store S overrides) is handled **read-side as a harmless idempotent re-upsert** (resolver computes Tenant ⊕ Override; override wins; FR-021 makes it a no-op) — not special-cased in the trigger. **Rationale:** the change-log carries only `product_id`+`op` (payload resolves at read), so fan-out pre-resolves nothing — pure write-amplification; R8 (light-write/heavy-read) governs; FR-022 = server-guaranteed completeness, not consumer contiguity. **Lock review:** worst case ONE insert per raw UPDATE — no amplification. **Propagated to** research R9, data-model §2/§3, tasks T012/T013/T042/T044, execution-map (010-SCHEMA + 010-US2-DELTA). **`010-SCHEMA` is now UNBLOCKED.**
- **F2 — ✅ FIXED 2026-06-03.** A second `/speckit-analyze` (R9-propagation pass) found research R2 still said the cursor "encodes `(tenant, store, sequence)`" — an orphan contradicting R9 + data-model §2. Corrected to "encodes `(tenant_id, sequence)`; store scope applied at read." Internal-only (opaque cursor). **Spec set now has zero known inconsistencies.**
- **R-4 — 🟡 LOW — "reuse" should be "create".** FR-070/R6 say "reuse/extend the 003 §9 `catalog_lookup_failure_rate`" + `reconciliation_mismatch_rate`, but **neither metric exists in the codebase** (verified: no matches in api/worker). T090 must *create* them. Wording only — work already scoped.
- **R-5 — 🟡 LOW** — per-row token named `row_cursor`/`cursor`/`row_version` three ways; lock `row_cursor` in T010 YAML. (= analyze I2, restated.)

**Deflated (NOT findings — over-flagged by the verification pass):** "no resolution service exists" is expected US1 work (§8 + T035 already scope building Tenant⊕Override); the spec never claimed one pre-exists.

### Verified-TRUE (external review, for confidence)

Auth (`PosOperatorAuthGuard` device-principal), `branch_id ≡ store_id` (FK in `auth_tokens.ts:51`), R1's "no monotonic version column on 003 tables" premise, `outbox_events` + empty-GUC RLS CASE guard (`0010_…:127`) + `DecimalAmount` regex (`pos-sales/sales.yaml:329`) precedents, `0015` as next migration — all confirmed against code. The delta mechanism, RLS pattern, and money discipline are sound.

### `/speckit-analyze` findings (2026-06-03) — internal consistency

1. **0 CRITICAL, 0 HIGH-blocking by internal consistency.** 39/40 requirements fully mapped (100% addressed). (Note: the external pass found R-1 because it checked claims against code, which `/speckit-analyze` does not.) Minor polish, NOT blocking:
   - **I2 (terminology, LOW)** — the per-row change token is named `row_cursor` / `cursor` / `row_version` across data-model §1/§4 + FR-050. **Lock one name (`row_cursor`) in the `010-CONTRACT` (T010) YAML** so the consumer sees one term.
   - **C2 (FR-060 ETag, MEDIUM)** — `MAY` content-hash/ETag is unimplemented. Acceptable as deferred; note "deferred, `MAY`, not v1" at the contract/US1 slice.
   - **U2 (alias trigger, MEDIUM)** — the `product_aliases` trigger must resolve the parent `product_id` into the change-log row. **Encoded** in `010-SCHEMA` (T013) acceptance + the map validation.
2. **Stale plan.md header (I1, LOW)** — plan.md says branch `spec/010-…` and references `feat/009-us3-idempotency`; actual branch is `010-pos-catalog-read-down-sync` and in-flight 009 is `feat/009-us4-salelinked`. Cosmetic; fix on next plan edit.
3. **Perf is report-only (A1)** — no numeric p95/p99 pinned; set + record against a ~50k-product store at `010-POLISH` (T091), report-only per 005/008 precedent (no perf env).

---

## Next recommended action

**No open pre-gate blockers.** R-1 ✅ (`/speckit-clarify`, Option B), R-3 ✅ (research R9), F1 ✅ fixed. Recommended: a final `/speckit-analyze` to confirm R-3/R9 propagation is clean (as was done for R-1), then dispatch.

**Dispatch the foundational wave once the owner approves the gated slices in-session:**

1. **`010-SIGNOFF-READONLY`** (record the DB-trigger decision in data-model §3) — non-code, do first.
2. **`010-SETUP`** (module skeleton).
3. **`010-CONTRACT`** `[GATED]` (R-1 resolved — ready) ∥ **`010-SCHEMA`** `[GATED]` (after R-3) — the GATED-FOUNDATIONAL pair; both must merge before any GREEN. **`010-CONTRACT` is the POS-Pulse 010 unblock half** (contract pinned).
4. Then **`010-ISOLATION-HARNESS`** → **`010-US1-SNAPSHOT`** 🎯 (MVP) → `US2` → `US3` → `POLISH` → `CLOSEOUT`.

**`main` has NO branch protection — CI is advisory; verify each PR's `db-integration` manually before merge** (per the 009 CI posture).
