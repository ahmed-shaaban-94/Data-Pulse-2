# Wave Status — `015-pos-sale-posting-to-erpnext`

> Human-readable summary of where the spec stands. 015 is the **keystone** of the
> ERPNext integration arc: it turns a DP2 sale fact (008) into ERPNext accounting
> truth over the fixed 012 pull/feed contract, resolving items via 013. This is a
> **planning / docs-only** spec (like 011/012/013's spec PR) — no `plan.md`,
> `tasks.md`, `data-model.md`, `execution-map.yaml`, and no dispatchable code
> slices. Implementation stays blocked pending 015's own Spec-Kit chain.

**Last updated:** 2026-06-05 by Ahmed Shaaban — prerequisite reconciliation: implementation prereqs 1–3 (P-DP-008-LIVELOOP #496/#497, 014-CRUD #495, 012 `erpnextItemRef` #494) now SATISFIED on `main`
**Spec:** `015-pos-sale-posting-to-erpnext` (`specs/015-pos-sale-posting-to-erpnext/`)
**Base:** verified against `origin/main` (spec MERGED via #493, `1faea76`)
**Status:** spec + companions **MERGED to `main`** (#493); open questions **RATIFIED** via the [2026-06-05 owner rider](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md). Planning lane complete; **implementation not yet started** (no `plan.md`/`tasks.md`/`execution-map.yaml`). Next live step: 015's own Spec-Kit chain (`/speckit-plan`) + the `[GATED]` `erpnext.posting.requested` registration.
**Active finding(s):** none new (inherits 013 `AUTO_MATCH_NO_SOURCE` → v1 manual-only)

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

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML (incl. `posting-feed.yaml`),
`package.json`/lockfile, CI, connector, POS, or Console file changed. **No runtime
behavior changed.** This slice adds the 015 planning spec + companions under
`specs/015-pos-sale-posting-to-erpnext/` **plus the durable owner-decision rider**
`specs/011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md`
— nothing else. **Merged to `main` via PR #493** (`1faea76`).
