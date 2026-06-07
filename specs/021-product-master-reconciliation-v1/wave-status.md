# Wave Status — `021-product-master-reconciliation-v1`

> Human-readable summary of where the spec stands. 021 is the **product-master
> reconciliation** surface — 017's **run → report → repair** shape applied to
> 013's product/item mapping (the inverse of 014's stock reconciliation). It
> reconciles the DP2 product master against ERPNext items over 013's
> `erpnext_item_map`.

**Last updated:** 2026-06-07 by Ahmed Shaaban — **planning chain MERGED to `main`** via PR #525 (squash `75d9967`).
**Spec:** `021-product-master-reconciliation-v1` (`specs/021-product-master-reconciliation-v1/`)
**Base:** `main` (planning produced in an isolated worktree off `cfbf0a4`; merged via the combined `docs/019-025-planning-wave` branch, since deleted).
**Status:** **PLANNING-COMPLETE — NOT dispatched for implementation.** Full SpecKit artifact set on `main`. No `execution-map.yaml`, no slice ledger yet. **Docs-only** — the `[GATED]` `0022` table family and the operator OpenAPI contract are described in **prose only**.

### Artifacts on `main`
`spec.md` (3 US, 20 FR, 7 SC) · `plan.md` (Constitution Check §I–XIV) · `research.md` (R1–R10) · `data-model.md` (`[GATED]` run / result / append-only repair_attempt; prose-only) · `tasks.md` (41 tasks, `[GATED]` flags) · `analysis.md` (0 CRITICAL / 0 HIGH / 1 MED / 5 LOW) · `review.md`.

### Key resolved design decisions
- **READ-NOT-MUTATE / not an authority handover (§IX):** 021 reads + repairs over 013's existing `erpnext_item_map` lifecycle; owns **no new mapping primitive**.
- Mirrors 017's run→report→repair; cookieAuth/DashboardAuthGuard **human-only** (NOT connectorBearer).
- New `[GATED]` `0022_erpnext_product_reconciliation` table family (indicative number — **collides with 020's indicative `0022`**, see #520) + `[GATED]` `product-reconciliation.yaml`.
- **MVP (US1) is connector-free.** US3 (`unmapped_erpnext_item`, `attribute_drift`) is **stub-tolerant** — inert until the live ERPNext-item view ships.

### Deferrals / blockers
- **MED finding F3 (cross-system, BLOCKS US3):** the live ERPNext-item read is external/gated — `021-ITEM-VIEW-CONTRACT`, tracked under the **live-leg frontier epic, issue #524**. v1 ships the run skeleton + DP2-side classes only (honest 017-style split).
- **Migration-number collision** with 020 — tracked as **issue #520**.

### Next recommended action
Dispatch the `[GATED]` **SCHEMA** (`0022_erpnext_product_reconciliation`) + `[GATED]` **021-CONTRACT** (`product-reconciliation.yaml`) approval slices (tasks T004/T005/T007) — they are foundational and block all three user stories. US1 (connector-free) is the first independently shippable MVP; US3 stays stub-tolerant until #524 clears.
