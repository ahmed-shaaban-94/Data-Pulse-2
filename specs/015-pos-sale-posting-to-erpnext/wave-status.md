# Wave Status — `015-pos-sale-posting-to-erpnext`

> Human-readable summary of where the spec stands. 015 is the **keystone** of the
> ERPNext integration arc: it turns a DP2 sale fact (008) into ERPNext accounting
> truth over the fixed 012 pull/feed contract, resolving items via 013. The full
> Spec-Kit planning chain (`plan.md` / `data-model.md` / `tasks.md` /
> `execution-map.yaml`) is MERGED (#500); **MVP implementation is now UNDERWAY** on
> branch `feat/015-pos-sale-posting-mvp` (SIGNOFF → SETUP → [GATED] EVENT-TYPE +
> SCHEMA → ISOLATION-HARNESS → US1-FEED 🎯).

**Last updated:** 2026-06-06 by Ahmed Shaaban — **015 implementation COMPLETE end-to-end.** All capability slices shipped: US1-FEED (#501) + T034 HTTP-edge (#502) + US2-ACK (#503) + US3-REVERSAL incl. US4 closeout (#504); POLISH on `feat/015-polish` (this patch).
**Spec:** `015-pos-sale-posting-to-erpnext` (`specs/015-pos-sale-posting-to-erpnext/`)
**Base:** planning chain MERGED via #493 + #500; implementation off `origin/main`
**Status:** **015 FUNCTIONALLY COMPLETE.** SIGNOFF + SETUP + `[GATED]` EVENT-TYPE + `[GATED]` SCHEMA (0019) + ISOLATION-HARNESS + 🎯 US1-FEED MERGED (#501, `f1f9340`); T034 HTTP-edge MERGED (#502, `11a8d85`); **US2-ACK MERGED (#503)** — connectorAckOutcome (posted/failed_transient-re-head/permanently_rejected + two-layer idempotency + §XII 404); **US3-REVERSAL + US4 closeout MERGED (#504)** — void/refund→reversal work-item (cross-slice 008 emit + reversalOf projection + REVERSAL-CARDINALITY) + US4 failure-posture (rider R4 no-unknown-items + disabled-Item=ack-path carve); **015-POLISH** (this branch) — §VII `erpnext_posting_reconciliation_total` in the shared api+worker metrics, report-only k6 `erpnext-posting.js`, coverage gate.

### Slice ledger (all GREEN, WSL Testcontainers)
| Slice | PR | Result |
|---|---|---|
| US1-FEED 🎯 | #501 | feed 5/5, consumer 5/5 |
| T034 HTTP-edge | #502 | 11/11 |
| US2-ACK | #503 | service 7/7 + HTTP-edge 8/8 |
| US3-REVERSAL (+US4) | #504 | api 53/53 (3 reversal) + worker 7/7 + 008-sales 141/141 |
| POLISH | this | signals 4/4 + cardinality 50/50; module coverage stmts 83.45 / branch 81.15 / funcs 94.73 / lines 85.12 (≥80% gate met) |

> **Coverage note:** the ≥80% POLISH gate is met on every axis for the
> erpnext-posting module (controller 85/100, service 90/89/93, projection
> 94/83/100, DTOs 100 + 84). `erpnext-posting.module.ts` reads 0% — it is pure
> NestJS DI wiring exercised only on a full-app boot, never in the hand-rolled
> `Test.createTestingModule` harnesses (the same way every feature module
> reports). The repo's *global* jest thresholds (96/90/97) apply to the full-suite
> aggregate, not a single-feature `--coverage` run; `--coverage` is non-blocking in
> CI (009-CI-OPT precedent).

### Deferrals carried (not blockers)
- **DLQ drain + reconciliation RUN + repair API = 017** (015 produces `permanently_rejected` rows + the `erpnext_posting_reconciliation_total` flag; the run/repair surface is a separate Spec-Kit chain). 
- **Payment Entry** = later separately-gated arc (interim Sales-Invoice-only / outstanding-AR, rider R1).
- **Perf report-only** — no perf env (005/008/009/010 precedent); k6 thresholds carried, not gating.
- **The `failed_transient` re-offer is bounded** by `POSTING_RETRY_BUDGET` (DP2-side cap → `permanently_rejected` at the ceiling), closing the unbounded-retry correctness gap the contract's "bounded by a retry budget" requires.
- The pull-time stale-map omission (a confirmed map retired between creation and pull) stays a latent edge handled safely (omit, never corrupt); flipping such stranded rows to `permanently_rejected` is 017 re-resolution work (a status write in the GET would break idempotent replay).

### T034 scope correction (the deferred HTTP-edge gap, verified 2026-06-05)
The MVP feed spec drove the *service* directly; T034 adds the real HTTP surface. Investigation shrank T034 to **four real behaviors** — two of the originally-listed paths **do not apply to the pull endpoint** and are documented as out-of-scope, not implemented:
- **`snapshot_required` (409) — NOT implemented (reserved).** 015 does **not** prune `erpnext_posting_status` (dead-letters persist for 017), so every cursor ≤ max is fully servable and a **caught-up cursor returns an empty 200**, never a 409. There is no stale-horizon trigger (unlike 010, which prunes its change-log). Reserved for a future retention model (017). The only correct future trigger would be `since > max` (feed-reset recovery) — exotic, no connector consumer exists yet, deliberately not built.
- **non-disclosing 404 — NOT on the pull.** `connectorPullPostings` has no `workItemRef` path param and the cursor is a bare global `sequence` bigint (no embedded scope); RLS scopes the rows, so there is no foreign-ref to reject. The `not_found` path belongs to `connectorAckOutcome` (US2-ACK).
- **Tested (T034):** 401 unauthenticated + wrong-scope (dashboard_api/pos/pos_operator REJECTED, only `connector` accepted — the 012 connectorBearer machine gate, proven through the REAL guard + real `auth_tokens`); 400 strict DTO (bad `since` / over-range `limit` / unknown key); 200 happy path; 200 empty on a caught-up cursor.

### MVP build results (WSL Testcontainers)
- `[GATED]` SCHEMA (0019 `erpnext_posting_status`): migration round-trip **16/16**, migrate allowlist **10/10**, schema-shape **11/11**. O-3 unique keyed on the collision-proof `source_ref_id` (NOT `source_system/external_id` — the REVERSAL-CARDINALITY fix, so multiple partial refunds per sale each post).
- `[GATED]` EVENT-TYPE (`erpnext.posting.requested`): registry **5/5**.
- ISOLATION-HARNESS: RLS sweep **8/8**.
- 🎯 US1-FEED: **two-moment 015-RESOLVE split** (eligibility at row CREATION in the worker `PostingRequestedConsumer` → `pending`/`permanently_rejected`; wire assembly at PULL is a pure read → 012 idempotent replay holds). Consumer spec **5/5** (resolvable→pending, ad-hoc→`unmapped_item`, no-warehouse→`unmapped_store`, idempotent re-run via `ON CONFLICT`, sale-fact-untouched). Feed spec **5/5** (resolved `erpnextItemRef`, posted-excluded, exact-decimal money + `businessDate`, cursor ordering + replay, limit cap). Auth = a new `connector` bearer scope + `ConnectorAuthGuard` (type-only, no migration — `auth_tokens.scope` is free text). The posting trigger emits `erpnext.posting.requested` in-transaction from the 008 `SaleProcessingProcessor` when a sale first becomes processed (cross-slice edit; 008 regression **7/7** GREEN after fixing the UUID-typed `correlation_id`). Consumer wired into the drainer registry via the WorkerModule `drainerProcessorProviderFactory` (race-free: before the runner's `onModuleInit` start).
**Active finding(s):** REVERSAL-CARDINALITY (resolved — O-3 unique keyed on the originating row's own pair, data-model §5); inherits 013 `AUTO_MATCH_NO_SOURCE` → v1 manual-only.

---

## SIGN-OFF Decisions (015-SIGNOFF, T001–T003 — recorded 2026-06-06)

### T001 — `015-SIGNOFF-STATE`: a new `[GATED]` `erpnext_posting_status` table (NOT derive-on-read)

**Decision: a new `[GATED]` state table.** 015 records, per DP2 sale (and per void/refund terminal event), the state of its ERPNext posting — `pending` → `posted` / `failed_transient` / `permanently_rejected` — plus the ERPNext `documentRef`. Derive-on-read is **infeasible**: the 008 sale fact (`0012`) carries no posting columns and must stay immutable (the 012 contract: *"the sale fact is NEVER mutated by an outcome — only its posting status is recorded"*), and an externally-assigned ERPNext `documentRef` **cannot be derived** — so O-3 (exactly-one document per sale) is unenforceable without persisted state. The 010 read-down feed set the precedent (a `[GATED]` `0015` change-log table; the app/outbox-mirror alternative was rejected) for a *weaker* need. **Owner-authorized in-session 2026-06-06.** Full rationale: [data-model.md §2](./data-model.md#2-the-load-bearing-decision--state-table-vs-derive-on-read).

### T002 — interim Sales-Invoice-only / outstanding-AR mode (rider R1)

015 posts a **submitted Sales Invoice only** (with stock impact) — **no Payment Entry / tender** state or payload. This interim mode is **gated** and **not finance-complete**: expect **unpaid/outstanding** ERPNext invoices (open AR) until the Payment Entry arc ships (DP2 tender model → 012 payment extension → connector PE → payment repair). Deriving a PE from `posTotal` is **STOP-and-raise** (not ratified). The signed target (SI + associated PE) is unchanged, not replaced. [spec §5.2 / rider R1].

### T003 — DLQ / `permanently_rejected` state only; the reconciliation run is 017

015 **produces** the `permanently_rejected` rows + reconciliation flags; the **DLQ drain + reconciliation run + repair API is 017** (a separate Spec-Kit chain, not yet specced). 015 adds no scheduled job, no repair endpoint, no ERPNext-Bin fetch. [spec §8, §10.4].

---

## TL;DR

015 implements **exactly** the two SIGNED 011 decision records:

- **Posting** (011-DR-POSTING): one **submitted Sales Invoice per DP2 sale**
  (1:1), async via outbox + connector pull, `businessDate`-driven posting date,
  idempotent on `sourceSystem + externalId` + payload hash, void/refund as a
  **new reversing document**, retry → DLQ + reconciliation (DP2 fact never
  mutated). **The signed target remains Sales Invoice + associated Payment
  Entry**; the first implementation slice runs the **owner-ratified interim
  mode** (invoice-only / outstanding AR — **gated, not finance-complete**;
  rider R1).
- **Stock impact** (011-DR-STOCK-IMPACT): the Sales Invoice posts with **"Update
  Stock" ON**, correlated by the sale's `sourceSystem + externalId`, **never**
  double-counted against the DP2 009 operational ledger.

Transport: the **fixed 012 `posting-feed.yaml`** (consumed as-is — work-items
out via `connectorPullPostings`, outcomes back via `connectorAckOutcome`;
satisfies O-1..O-7). Item identity: **015-RESOLVE** (the 013 deferral) — lazy
posting-time resolution against **confirmed** `erpnext_item_map` rows;
unmapped → fails-to-DLQ.

DP2 makes **no outbound HTTP calls**; the connector posting adapter (G8 boundary)
is the only ERPNext-calling component, behind the 012 contract (ADR 0008).

---

## Deliverables (docs-only)

| File | Purpose | State |
|---|---|---|
| `spec.md` | Planning spec: posting model (per both SIGNED records), transport (012 O-1..O-7), 015-RESOLVE, idempotency/temporal/money, inherited gates, failure posture, OQs, out-of-scope | Authored |
| `resolution-concepts.md` | 015-RESOLVE concept catalogue + **ratified** OQ-5/OQ-6/OQ-8-bis resolutions (rider 2026-06-05) | Authored |
| `follow-up-notes.md` | Inherited gates (DP-014, P-DP-008-LIVELOOP, G3/G7/G8), `[GATED]` follow-ups, future 012 contract changes (proposed / **required pre-implementation** per rider R2), forward refs | Authored |
| `wave-status.md` | This file | Authored |
| [`../011-…/decisions/posting-decision-rider-2026-06-05.md`](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md) | **Durable owner-decision rider** (011-DR-POSTING-R1, SIGNED): ratifies OQ-5/6/7/8/8-bis + re-affirms live-loop not absorbed | Authored (this patch) |

> **NOT** created (later-phase / `[GATED]` surfaces): `plan.md`, `tasks.md`,
> `data-model.md`, `execution-map.yaml`, any OpenAPI YAML (incl. any edit to
> `posting-feed.yaml` — read-only input), any Drizzle schema / SQL migration,
> any app or connector code, any outbox event-type registration.

---

## Decisions RATIFIED ([owner rider 011-DR-POSTING-R1, SIGNED 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md))

| ID | Ratified decision | Where |
|---|---|---|
| **OQ-7 / Payment Entry (rider R1)** | **Signed target unchanged: Sales Invoice + associated Payment Entry per sale.** First implementation slice runs the **owner-ratified interim mode** — submitted Sales Invoice / **outstanding AR only** — explicitly **gated** and **not finance-complete** (expect unpaid/outstanding ERPNext invoices until the tender/payment extension ships). Payment Entry requires: DP2 tender model → 012 payment extension → connector idempotent PE creation → payment repair semantics. Deriving a PE from `posTotal` is **not ratified**. | spec §5.2, §11 |
| **OQ-5 (rider R3)** | Disabled / non-sales ERPNext Item at posting time → **fails-to-DLQ; no silent fallback, no substitute item**; **operational sellability stays DP2-authoritative**. Divergence = reconciliation case (017), never a silent override. | resolution-concepts §5 |
| **OQ-6 (rider R4)** | Inbound unknown-items and outbound unmapped-for-posting are **separate operational states**; resolving an unknown item creates a `tenant_product` that **still needs a confirmed 013 mapping** before it can post. 015 never routes posting failures into the unknown-items queue. | resolution-concepts §6 |
| **OQ-8 (rider R5)** | DP-014 not built → absent a resolved warehouse, **fail-to-DLQ (`unmapped_store`-class)** — **never guess the ERPNext warehouse**. | spec §10.1 |
| **OQ-8-bis (rider R2)** | **DP2 resolves line→Item at projection** (O-1 self-sufficiency); failed resolution → DLQ in DP2 **before** the work-item is offered. Connector **MUST NOT** guess Item identity, reach back into DP2, or hold a second mapping copy. Implementation **GATED on the 012 correction/extension** (`SaleLine.erpnextItemRef` or equivalent + `tenantProductRef` description correction) — **required before 015 implementation**. | resolution-concepts §7 |

---

## Dependencies & gates (verified 2026-06-05 against `origin/main @ 0cafd0c`, git-truth)

| Gate | State |
|---|---|
| **gated_by**: posting decision (011-DR-POSTING) SIGNED | ✅ SIGNED 2026-06-03 |
| **gated_by**: stock-impact decision (011-DR-STOCK-IMPACT) SIGNED | ✅ SIGNED 2026-06-03 |
| **depends_on**: 012 `posting-feed.yaml` on `main` | ✅ present (`1.0.0-draft`; git-verified) |
| **depends_on**: 013 `erpnext_item_map` MVP on `main` | ✅ CLOSED — module + `0017` migration (git-verified); `013-RESOLVE` lands here |
| **depends_on**: 008 sale fact on `main` | ✅ CLOSED — `sales`+`sale_lines`+`0012` migration (git-verified) |
| **depends_on**: DP-014 warehouse map | ✅ **CLOSED** — 014-CRUD merged (#495, `4d0cdd3`): `erpnext_warehouse_map` table + `0018_erpnext_warehouse_map.sql` migration + module on `main` (git-verified 2026-06-05) |
| **prerequisite**: P-DP-008-LIVELOOP | ✅ **SHIPPED** — DP-008-LIVELOOP merged (#496 `6dd1e84` + #497 `12013cc`): `sale.captured` registered in `OUTBOX_EVENT_TYPES` + in-transaction emit + `SaleWorker.start()`; `processed_at` set off-request, Docker-gated e2e (git-verified 2026-06-05). The feed can now carry real processed work-items e2e. |
| G0 repo truth | ✅ worktree from `origin/main @ 0cafd0c` |
| G2 contracts | ✅ `posting-feed.yaml` present |
| G3 / G5 / G7 / G8 | defined, not satisfied (planning lane) |

---

## Next recommended action

**015 is functionally complete on `main` (US1–US4) + POLISH in review.** The next
arc work is **016** (tax/fiscal — ETA passthrough is already a nullable field on the
012 ack) and **017** (the DLQ drain + reconciliation RUN + repair API that consumes
015's `permanently_rejected` rows + the `erpnext_posting_reconciliation_total` flag),
each its own Spec-Kit chain. Payment Entry remains the later separately-gated arc
(DP2 tender model → 012 payment extension → connector PE → payment repair).

<details><summary>Original (planning-lane) recommended-action history</summary>

015's spec is authored (planning lane complete). **Prerequisites 1–3 below are
now SATISFIED on `main` (verified 2026-06-05)** — the next live work is the
`erpnext.posting.requested` event-type (4) and then 015's own Spec-Kit chain (5).
The implementation arc, in order:

1. ~~**P-DP-008-LIVELOOP**~~ — ✅ **DONE** (#496 + #497): processed sales are now
   feedable end-to-end (rider R6 honored — it shipped as its own `specs/008`
   slice, never absorbed into 015).
2. ~~**014-CRUD**~~ — ✅ **DONE** (#495): the store→warehouse map (`erpnext_warehouse_map`
   + `0018` migration) is on `main`.
3. ~~**`[GATED]` 012 contract correction**~~ — ✅ **DONE** (#494): `SaleLine.erpnextItemRef`
   is now `required` in `posting-feed.yaml` (DP2-side resolution; rider R2 satisfied).
4. **`[GATED]` `erpnext.posting.requested` event-type registration** — ⏳ **NEXT
   GATED STEP.** Not yet in `OUTBOX_EVENT_TYPES` (git-verified). Scope it as a
   `[GATED]` `packages/db` slice (T541-style approval), ideally within 015's plan.
5. **015's own Spec-Kit chain** (`plan.md` → Constitution Check → `[GATED]`
   schema/contract as needed → `tasks.md` → `execution-map.yaml`), then the
   posting feed + worker + `015-RESOLVE` — in the **interim
   invoice-only/outstanding-AR mode** (rider R1). ← **the recommended next action
   for 015 itself** (`/speckit-plan`); steps 1–3 no longer block it.
6. **016** tax/fiscal; **017** DLQ drain + reconciliation + repair.
7. *(Later, separately gated — rider R1)*: tender model → 012 payment extension
   → connector idempotent Payment Entry → payment repair semantics →
   **Payment Entry posting** (completing the signed target).

</details>

---

## Closeout note (docs-only — planning slice #493)

No application code, DB schema/migration, OpenAPI YAML (incl. `posting-feed.yaml`),
`package.json`/lockfile, CI, connector, POS, or Console file changed. **No runtime
behavior changed.** This slice adds the 015 planning spec + companions under
`specs/015-pos-sale-posting-to-erpnext/` **plus the durable owner-decision rider**
`specs/011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md`
— nothing else. **Merged to `main` via PR #493** (`1faea76`).
