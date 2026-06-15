# 035 — Open-Question Decision Options (owner brief to tee up the G2 contract)

> **DECISION-SUPPORT, NOT DECISION-MADE.** This annex presents options + implications
> for the two carried Open Questions in [`spec.md`](./spec.md) §11 that **block
> finalizing fields in the G2 contract** (OQ-4, OQ-7), plus the deferred tax question
> (OQ-2). It **does not** mark any OQ resolved, does not mutate `spec.md`'s carried-OQ
> section, does not author any contract/schema, and does not advance the gate. The
> spec stays SPECIFY-only + gated plan/tasks until owner ruling. Nothing here asserts
> the settlement model is built.
>
> **Placement (owner can redirect):** authored at
> `specs/035-sale-settlement-and-receivables-model/oq-decision-options.md`. `specs/**`
> is not a `[GATED]` path, so no gate approval was required to author this prose; it is
> planning input that feeds the G2 contract slice **after** the owner rules. No
> `plan.md`/`tasks.md` change is implied (the gated `plan.md`/`tasks.md` already
> sequence these as blockers).
>
> **Status:** DRAFT — for owner review. **Date:** 2026-06-15. **Owning repo:**
> Data-Pulse-2. **Decider:** Owner (Ahmed Shaaban).

---

## How to read this brief

Each OQ falls into a class, and that class **determines whether DP-2 may recommend at
all** (same governance rule as [031's brief](../031-operator-authorization-envelope/oq-decision-options.md)):

| Class | Meaning | DP-2's posture |
|---|---|---|
| **DP-2-local** | DP-2 owns the artifact the question decides. | **Recommend** — owner ratifies. |
| **Cross-system / boundary** | The answer is owned by another system (ERPNext valuation authority) or by an upstream spec that is itself unresolved (DP-026). DP-2 only **consumes** the answer. | **Defer** — present DP-2-side *implications* of each resolution; do **not** pick. Crossing this fence would violate Constitution §I (reference-not-truth) and the spec's claim ceiling (§13). |

| OQ | Question | Class | This brief's posture |
|---|---|---|---|
| **OQ-4** | DP-026 reversal technical compatibility | **Cross-system** (DP-026 is itself OPEN) | **Defer** — implications only; cannot close downstream of an open upstream. |
| **OQ-7** | Payment Entry ownership (DP-2 vs ERPNext) | **Cross-system** (ERPNext valuation boundary) | **Defer** — present implications of each ownership ruling; do **not** pick. |
| **OQ-2** | Egypt VAT allocation | **Cross-system** (G6/ADR-0003 activation) | **Defer** — tax-pending; no allocation rules. |

**Evidence basis** (read this session, `origin/main`, cited inline): `specs/026-returns-reversal-contract/spec.md`; `specs/011-.../decisions/posting-decision-record.md` + `…/posting-decision-rider-2026-06-05.md`; `.specify/memory/constitution.md` §I / §IX.

**The two decisive facts threaded through everything below:**
1. **OQ-4 cannot be closed by DP-2 because its upstream is open.** DP-026 is itself a
   `DETERMINATION — OPEN` (026 spec status, line 7), with a traced sale-`externalId` vs
   per-reversal-`source_ref_id` anchor mismatch that is **bench-unverified** (026 §3.x,
   §0.1 honesty caveat). You cannot certify "a receivable consumes a reversal cleanly"
   against a contract that hasn't itself been determined. OQ-4 closes **only after**
   DP-026's CHECKPOINT-2 both-sides determination closes.
2. **OQ-7 already has a documented holding pattern, not a vacuum.** 011-DR-POSTING
   signed the *target* "Sales Invoice + associated Payment Entry," but **011-DR-POSTING-R1
   explicitly DEFERS Payment Entry and does-NOT-ratify** deriving it (R1 lines 19–49:
   "MUST NOT be implemented until ALL of [4 gated prereqs]"). So OQ-7 is not unmapped —
   it is a *carried, signed deferral* awaiting an ownership ruling.

---

## OQ-4 — DP-026 reversal technical compatibility  *(cross-system → DEFER; implications only)*

**Question (spec.md §11 OQ-4):** Is the existing DP-026 reversal surface technically
compatible with how a **receivable** must *consume* a reversal outcome (when a
credit/insurance sale is later voided/returned, the receivable must cancel/adjust
cleanly, never via a new reversal path — NG-1)?

**Why DP-2 must NOT pick:** the question is downstream of DP-026's own open
determination. DP-2 picking "compatible" would assert a fact about an unresolved
upstream contract.

### What must happen upstream first

| Upstream state (DP-026) | DP-2-side (035) implication |
|---|---|
| **DP-026 determines the forward-feed reversal surface SUFFICES** (CHECKPOINT-2 closes "no extension") | 035 reversal-compatibility carriers (FR-024) bind to the existing reversal anchor. Receivable "reversal-consumed" terminal state references the DP-026 reversal outcome key. **Anchor risk:** the receivable must key off whatever DP-026 actually emits — if the sale-`externalId` / per-reversal-`source_ref_id` mismatch (026 §3.x) is unresolved, the receivable cannot reliably correlate a reversal to the right line. **So even "suffices" requires the anchor mismatch resolved first.** |
| **DP-026 determines the surface must be EXTENDED** (a later gated slice) | 035 reversal-compatibility carriers wait for that extension's shape; FR-024 stays open until it lands. Sequence: DP-026 extension → then 035 G2 reversal fields. |
| **DP-026 stays OPEN** (no determination) | **OQ-4 stays blocked.** 035 G2 may be authored for the *non-reversal* surface (payer/receivable/settlement/claim happy-path), explicitly carving out reversal-compatibility fields as a later additive `[GATED]` bump once OQ-4 closes. ← *this is the only path that lets G2 progress before DP-026 closes.* |

### Owner action for OQ-4

- ☐ **Acknowledge defer** — OQ-4 is gated on DP-026's determination; DP-2 does not pick.
- ☐ **Decide the carve:** may the 035 G2 contract proceed for the **non-reversal surface now**, with reversal-compatibility fields deferred to an additive bump after DP-026 closes? (Recommended — unblocks 4 of 5 children's happy-path; reversal binds later.) Or hold **all** of G2 until DP-026 closes? (Safer correlation, but blocks everything longer.)
- ☐ **Flag to DP-026 owner:** the receivable-correlation need adds weight to resolving the 026 §3.x anchor mismatch — surface it on 026's CHECKPOINT-2.

---

## OQ-7 — Payment Entry ownership  *(cross-system → DEFER; implications only)*

**Question (spec.md §11 OQ-7):** Which system is authoritative for the **payment-entry
record** — Data-Pulse-2, ERPNext (posted via connector), or a split? This blocks
finalizing payment-entry / cash-application field shapes (FR-013).

**Why DP-2 must NOT pick:** Payment Entry is an ERPNext doctype on the valuation side
of the §I reference-not-truth boundary; whether DP-2 *owns the operational record* vs
merely *posts to* ERPNext's is a cross-system authority decision. Constitution §IX's
source-of-truth table **does not list Payment Entry** (constitution lines 420–448) —
so there is no existing principle to derive the answer from; it is a genuine ruling.

### Options (owner picks one; DP-2 presents implications, does not choose)

| Option | What it means | DP-2-side (035) implication | Cost / risk |
|---|---|---|---|
| **7-A — DP-2 owns the operational payment-entry / cash-application record; ERPNext gets a posted projection** | Cash application, partial application, receivable balance changes are authoritative in DP-2; the connector posts a derived Payment Entry to ERPNext for valuation. | 035 owns full payment-application fields (FR-011/012), idempotent + audited; connector (009) consumes a posting projection. Consistent with DP-2 = operational source of truth (§IX sale fact, §III backend authority). | DP-2 carries the cash-application model + reconciliation against ERPNext's Payment Entry. Most build on DP-2 side. |
| **7-B — ERPNext owns Payment Entry; DP-2 captures intent + receivable, defers the money record** | DP-2 tracks the receivable and settlement *intent*; the actual payment/cash record lives in ERPNext, posted via connector. | 035 payment-entry fields shrink to references/intent; cash-application authority sits in ERPNext. FR-013 fields become "pointer to ERPNext Payment Entry," not an owned record. | Receivable balance now depends on an ERPNext round-trip for truth — tension with §I (ERPNext is valuation, not operational truth) and with offline/POS-first capture. Reconciliation latency. |
| **7-C — Split: DP-2 owns receivable + cash-application; ERPNext owns the GL Payment Entry as valuation projection** | Operational truth in DP-2, accounting truth in ERPNext, reconciled. Aligns with 011-DR-POSTING's *target* ("Sales Invoice + associated Payment Entry" in ERPNext) **while** DP-2 owns the operational receivable. | 035 owns receivable + cash-application (like 7-A); the *ERPNext Payment Entry* is explicitly the valuation projection (011-DR-POSTING target), posted by connector 009 once R1's gated prereqs clear. | Requires clear reconciliation contract between the two records. Most faithful to existing signed posting target + §I/§IX, but most coordination. |

### The existing signed constraint the owner must honor

011-DR-POSTING-R1 already ruled Payment Entry **MUST NOT be implemented** until 4
gated prereqs ship, and **does not ratify** deriving a Payment Entry from `posTotal`.
**Whichever of 7-A/B/C is chosen, the ERPNext-side Payment Entry posting remains
gated behind R1.** So OQ-7's ruling decides the *035 field shapes*; it does **not**
lift R1's posting gate.

### Owner action for OQ-7

- ☐ **Rule 7-A / 7-B / 7-C** (which system owns the payment-entry record). *DP-2-side lean, offered as context only, not a pick:* 7-C is the most consistent with the already-signed 011-DR-POSTING target **and** §I/§IX (DP-2 operational truth, ERPNext valuation) — but this is the owner's cross-system call.
- ☐ **Confirm** the ruling does not attempt to lift 011-DR-POSTING-R1's posting gate (it doesn't need to — OQ-7 finalizes 035 *fields*, R1 still gates ERPNext *posting*).

---

## OQ-2 — Egypt VAT allocation  *(cross-system / G6 → DEFER; tax-pending)*

**Question (spec.md §11 OQ-2):** How does VAT apportion across payers / co-pays?

**DP-2 posture: DEFER — tax-pending.** Per ADR-0003 tax is activation-only (G6). No
VAT allocation rules are authored; tax carriers stay placeholders (FR-023, NG-4).

- ☐ **Owner action:** confirm v1 stays tax-deactivated (no VAT allocation), **or**
  schedule G6 activation as separate gated work. Until then DP-2 invents nothing.

---

## Consolidated owner ask

| OQ | Class | Owner action |
|---|---|---|
| **OQ-4** reversal compat | Cross-system (DP-026 open) | ☐ acknowledge defer · ☐ decide the G2 carve (non-reversal surface now vs hold all) · ☐ flag 026 §3.x anchor to DP-026 owner |
| **OQ-7** Payment Entry ownership | Cross-system (ERPNext boundary) | ☐ **rule 7-A / 7-B / 7-C** · ☐ confirm R1 posting gate stays |
| **OQ-2** Egypt VAT | Cross-system (G6/ADR-0003) | ☐ confirm tax-deactivated v1, or schedule G6 |

**Gate reminder:** ruling these does **not** mark G2 satisfied and does **not**
authorize dispatch. After the rulings, the G2 contract slice can be authored
`[GATED]` (`packages/contracts/openapi/**`) against resolved field decisions, then the
owner's both-sides G2 approval flips the gate and unblocks the five children (POS 020,
Console 017/018/019, Connector 009 — Console 019 last, also needing DP-2 032 runtime
wiring). The blocked task IDs are sequenced in [`tasks.md`](./tasks.md) (T001=OQ-4,
T002=OQ-7, T003=OQ-2/G6 → T010 G2 contract).
