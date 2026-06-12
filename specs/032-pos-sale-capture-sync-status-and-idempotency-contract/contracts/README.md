# Phase 1 Contract Surface (PROSE) — Spec 032

**SPECIFY-ONLY. No OpenAPI YAML in this folder.** This README describes the intended contract surface in prose so `/speckit-tasks` and reviewers can reason about it. The real `packages/contracts/openapi/sales.yaml` §12 ops are authored by the owner-gated implementation slice. **Whether that YAML is authored contract-first or alongside service work is an OPEN owner decision (spec §13 item 4) and is NOT decided here.** Producing a `.yaml` here would both violate the SPECIFY-ONLY rule and prejudge that owner decision.

All ops below MUST (when authored by the slice) carry a stable `operationId`, an explicit `security` section bound to 028, the canonical error envelope `{ error: { code, message, request_id, details? } }`, the canonical status-code mapping, and no raw DB entities in responses (Constitution Principle IV, API Conventions).

## Surface 1 — Capture (existing; this slice formalizes the contract) — §6

- **Intent**: receive a POS-constructed capture (sale lines, integer-minor-unit money, operator/device/store provenance, client-supplied idempotency/external key).
- **Success**: `201` fresh; `200` replayed (idempotent, same sale, no duplicate) with a replay indicator.
- **Idempotency**: L1 `Idempotency-Key` (engaged on capture) + L2 atomic dedup (LIVE — F-4).
- **Events**: emits `sale.captured` in-transaction (already registered — F-5; verify producer binding, do not re-register).

## Surface 2 — Server-authoritative sale-status read — §7, §9

- **Intent**: read DP-2's authoritative status for a sale (the Console's source of sync truth).
- **Scope**: tenant + store scoped; cross-tenant → safe-404.
- **Read-only**: POS/Console observe; DP-2 decides.

## Surface 3 — Failed-sync (NEEDS_REPAIR) list — §9

- **Intent**: list DP-2-classified NEEDS_REPAIR sales for the later Console sync-ops UI.
- **Shape**: tenant + store scoped, newest-first, stable keyset/cursor pagination (clarify session 2026-06-12). Exact page-size/cursor shape deferred to the slice.

## Surface 4 — Sale search / receipt lookup — §9

- **Intent**: locate a sale / receipt for the repair workflow. Tenant + store scoped; generated-client only.

## Surface 5 — Audit / correlation timeline — §9

- **Intent**: read-only provenance/correlation timeline (028 provenance, `request_id`/`correlationId`), for diagnosis. Redacted at the emitter (Principle XIII/XIV).

## Surface 6 — Repair / retry op — §9, §11 item 7

- **Intent**: server-mediated, audited retry/repair that acts only on DP-2-classified NEEDS_REPAIR. Never a sale-fact rewrite. No POS-local override path.
- **Authority**: Console-mediated only is the planned posture; final confirmation is an OPEN owner decision (§13 item 3 / 029 Q11 / 028 OQ-2).

## Refusal taxonomy (binds 028) — §8

The §8 table is authoritative and is **not** re-decided here. Key invariants for the slice:
- `401`/`403` semantics owned by 028 (bound by reference; G10).
- `409` provenance-reuse is LIVE — **must not be regressed** (F-3).
- `422` AlreadyApplied is an OPEN owner decision (§13 item 1) — additive only, sequenced after the status/read slice; do not collapse the live `409` into it.

## Explicitly out of scope (do NOT author)

- Any `payments.confirm`/`settled_at`/tender-settlement op (F-2 — does not exist).
- Any 028 auth re-decision (bound by reference).
- Connector/ERPNext posting ops (architecture invariant: DP-2 is the boundary).
