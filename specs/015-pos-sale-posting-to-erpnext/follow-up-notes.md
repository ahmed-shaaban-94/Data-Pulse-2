# 015 Follow-up Notes — Inherited Gates, `[GATED]` Follow-ups & Forward References

**Feature**: 015-pos-sale-posting-to-erpnext
**Status**: Draft — forward references only (nothing here is authored or green-lit)
**Date**: 2026-06-05

> This document records, for 015, the implementation gates it **inherits but does
> not satisfy** in this planning lane, the **`[GATED]` follow-ups** its
> implementation will require (each its own approval slice), and **proposed
> future 012 contract changes** (recorded as proposed slices — never authored
> here). It mirrors the discipline of [012 follow-up-notes](../012-erpnext-connector-contracts/follow-up-notes.md):
> **name, do not author.**

---

## 1. Inherited implementation gates (defined, not satisfied)

| Gate | What 015 inherits | Where 015 defines it | Status |
|---|---|---|---|
| **DP-014 warehouse map** | The "Update Stock ON" target — an ERPNext Warehouse mapped 1:1 to the DP2 store [stock-impact §3/§4]. | spec §10.1 | ⏳ **014 planning chain only; SCHEMA/CONTRACT `[GATED]`+`proposed`, not built.** Minimal-v1 path: fail-to-DLQ (`unmapped_store`-class), never guess a default. |
| **P-DP-008-LIVELOOP** | Processed sale facts to feed work-items (`processed_at` set off-request). | spec §10.2 | ⏳ **GATED — separate slice under `specs/008`.** Owner decision 2026-06-05: NOT absorbed. 015 names it + defines expectations + sequencing only. **No** task/design content here. |
| **G3 (schema)** | Any new work-item / DLQ / posting-status state table beyond `0012`/`0017`. | spec §10.3 | ⏳ **`[GATED]` `packages/db`** — Drizzle schema + migration + `*.down.sql` + RLS. Flagged, not designed. |
| **G5 (idempotency)** | Exactly-one ERPNext document per sale; idempotent ack. | spec §8 | ✅ **designed** (planning lane) — `sourceSystem+externalId`+payload hash; reuses `IdempotencyInterceptor`. Verified at implementation. |
| **G7 (observability)** | Structured logs + §VII metrics (queue lag, failed-job rate, reconciliation-mismatch rate, DLQ depth) on the posting worker/feed. | spec §10.4 | ⏳ **017 seam** — 015 defines signals; 017 surfaces them. |
| **G8 (upgrade boundary)** | ERPNext-version concerns. | spec §10.4 | ✅ **boundary noted** — lands on the **connector posting adapter** (only ERPNext-calling component; DP2 makes no outbound HTTP calls). DP2 ↔ connector contract is version-independent (O-6). Not 015's to satisfy. |
| **G9 (rollout)** | n/a | — | Not applicable (planning lane). |

---

## 2. `[GATED]` follow-ups 015's implementation will require

Each is a **separate approval slice** — dispatching it is an explicit in-session
approval of that forbidden surface. **None is authorized by this docs PR.**

### 2.1 `erpnext.posting.requested` outbox event-type registration — `[GATED]` `packages/db`

- **What:** the outbox event type that turns a processed 008 sale (and each
  void/refund terminal event) into a pending posting work-item on the 012 feed.
- **Status:** **named, not registered** by 012 (follow-up-notes) and 013
  (wave-status: *"the `erpnext.posting.requested` registration lands [in 015]"*).
- **Gate:** adding an event type is a **`[GATED]` `packages/db`** approval PR
  (T541-style), per `docs/outbox/event-types.md`. **015 does not register it
  here** — it is a follow-up slice when 015's implementation needs it.

### 2.2 Posting feed + worker + `015-RESOLVE` implementation — `apps/api` / `apps/worker`

- **What:** the DP2-side feed endpoint (`connectorPullPostings` server impl), the
  outcome-ack ingest (`connectorAckOutcome` server impl), the posting worker, and
  the `015-RESOLVE` posting-time resolution against `erpnext_item_map`.
- **Gate:** application code — 015's own Spec-Kit chain (`plan.md` → `tasks.md` →
  `execution-map.yaml`) + Agent OS gates **before any code**. Not authored here.

### 2.3 Work-item / DLQ / posting-status state — `[GATED]` `packages/db` (if needed)

- **What:** any new table(s) for posting-status, DLQ membership, or
  reconciliation flags beyond what `0012`/`0017` provide (G3, §10.3).
- **Gate:** `[GATED]` schema slice (migration + `*.down.sql` + RLS + tenant
  scoping). Designed in 015's `data-model.md` (a later phase), not here.

---

## 3. Future 012 contract changes (RECORDED — NEVER AUTHORED HERE; one is REQUIRED pre-implementation)

The fixed `posting-feed.yaml` is **read-only input** to 015. Where 015 identifies
a needed contract change, it is recorded here as a **future `[GATED]` 012
slice** — the OpenAPI YAML is **never** authored by 015. Two of the rows below
are merely *proposed*; the **item-resolution correction/extension row is
REQUIRED before 015 implementation** (rider R2), and the tender row is
**required before Payment Entry posting** (rider R1).

| Proposed 012 change | Why 015 surfaces it | Resolution |
|---|---|---|
| **ERPNext item-search op** (DP2 → ERPNext) | 013's `AUTO_MATCH_NO_SOURCE` finding: barcode/item-code auto-match has no source op; v1 is manual-only. | Proposed future `[GATED]` 012 item-search extension. **Named, not authored.** v1 stays manual-only. |
| **Tender fields on the work-item + Payment Entry path** | The Payment Entry is deferred because 008 models no tender (gate A.5) and the work-item cannot carry tender (spec §5.2; **OQ-7 RATIFIED — rider R1**: signed target unchanged; interim invoice-only/outstanding-AR mode is **gated** and **not finance-complete**). | **Required before Payment Entry posting** (rider R1, gates the Payment-Entry path only): (1) DP2 tender/payment fact model (or approved equivalent payload); (2) versioned, backward-compatible 012 payment/tender extension; (3) connector idempotent Payment Entry creation; (4) payment repair/reconciliation semantics (017). Deriving a v1 Payment Entry from `posTotal` is **not ratified** — STOP-and-raise. |
| **`SaleLine.erpnextItemRef`** (resolved Item ref on the work-item) + `tenantProductRef` description correction | **OQ-8-bis RATIFIED (rider R2): DP2 resolves line→Item at projection.** Embedding the resolved ref (or an equivalent resolved-Item payload) makes the work-item self-sufficient for item identity; the stale connector-side wording in the `tenantProductRef` description is corrected in the same slice (superseded by owner decision, on the record). | `[GATED]` 012 correction/extension — **REQUIRED before 015's posting-feed implementation; gates ALL 015 implementation** (spec §13; resolution-concepts §7). Still never authored here. |
| **`RejectionReason.category = disabled_item`** | OQ-5 maps a disabled ERPNext Item to the nearest existing category (`unmapped_item`); a dedicated category would be more actionable. | Proposed future `[GATED]` 012 enum addition. **Named, not authored** (resolution-concepts §5). |

---

## 4. Forward references

- **016 — tax-and-fiscal-egypt-v1** — rides on 015's working posting; consumes
  the nullable `etaStatus` passthrough on the outcome ack (live only when 016
  ships). Out of 015 scope.
- **017 — sync-ops-and-repair-api** — drains the DLQ, surfaces the
  reconciliation state + mismatch reports + repair workflows over the correlation
  IDs that 015 produces. Out of 015 scope (the consumer of 015's DLQ state).
- **ADR 0008** — the accepted `Retail-Tower-ERP-Next-Connector` repo split; the
  connector posting adapter (the only ERPNext-calling component, G8 boundary)
  lives there, behind the 012 contract.
- **[011-DR-POSTING-R1 — posting decision rider, SIGNED 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md)**
  — the durable owner ratification of 015's OQ-5/OQ-6/OQ-7/OQ-8/OQ-8-bis
  (interim Payment-Entry mode; DP2-side resolution; fail-to-DLQ postures;
  live-loop not absorbed). Implementation slices verify against it.

---

## 5. Discipline restatement

Per the standing rules and CLAUDE.md: this is **planning / docs only**. Nothing
in this document authors application code, a DB schema/migration, OpenAPI YAML,
`package.json`/lockfile, CI, connector code, or registers an outbox event type.
Every `[GATED]` surface above is a **separate approval slice**, authorized only
by an explicit owner act — never as a side-effect of this spec.
