# Phase 1 Quickstart — Verification Narrative (Spec 032)

**SPECIFY-ONLY.** This is the verification story the implementation slice's tests must realize (test-first, Principle VI). It runs no code today; it describes what "done" looks like for the planned slice. None of it re-decides a §13 owner decision.

## Scenario A — Fresh capture (G5, §6)

1. POS sends a capture with a fresh `Idempotency-Key` and `(sourceSystem, externalId)`.
2. DP-2 validates, authorizes (028), persists the sale, sets server-authoritative status `captured`, emits `sale.captured` in-transaction.
3. **Expect**: `201`, replay indicator absent, exactly one sale, exactly one event.

## Scenario B — Replay (idempotency, G5, §6) — must not duplicate

1. POS re-sends the identical capture (same key, same body).
2. L1 returns the prior response; L2 atomic dedup (LIVE — F-4) guarantees no second sale even absent L1.
3. **Expect**: `200`, replay indicator present, still exactly one sale, no second `sale.captured`.

## Scenario C — Idempotency-key conflict (§8)

1. POS re-sends the same `Idempotency-Key` with a **different** body.
2. **Expect**: `409` (request-level idempotency conflict). Distinct from the fact-level provenance `409` below.

## Scenario D — Provenance reuse — live 409 preserved (F-3, §8)

1. A terminal event is re-delivered such that runtime maps it to `TerminalEventProvenanceConflictError`.
2. **Expect**: `409` exactly as today. **Regression check**: this MUST NOT become `422` or change shape. (The AlreadyApplied-422 path is an OPEN owner decision — §13 item 1 — and, if ever added, is additive, never a replacement for this `409`.)

## Scenario E — Failed sync → NEEDS_REPAIR (§8, §9) — never silent drop

1. A capture's downstream sync fails non-retryably.
2. DP-2 classifies it NEEDS_REPAIR, quarantines it with **provenance intact** (028), sets status `failed-needs-repair`.
3. **Expect**: the sale appears in the NEEDS_REPAIR list (tenant+store scoped, newest-first, keyset paginated); nothing is silently dropped; transient failures instead appear as `failed-retryable` with backoff.

## Scenario F — Server-mediated repair (§9, §11 item 7)

1. Via the (later) Console-consumed surface, a repair/retry is issued for a NEEDS_REPAIR sale.
2. **Expect**: the op is audited, acts only on the DP-2-classified NEEDS_REPAIR item, performs **no sale-fact rewrite**, and there is **no POS-local override path**. (Final repair-authority is an OPEN owner decision — §13 item 3.)

## Scenario G — Tenant / store isolation (Principle II, VI)

1. Tenant A reads tenant B's sale-status / NEEDS_REPAIR item.
2. **Expect**: safe-404 (same shape as "does not exist"), not 403; RLS bypass probe with wrong `app.current_tenant` returns zero rows; the drain worker establishes tenant context before DB access.

## Out of scope for this verification

- No tender-settlement / `payments.confirm` scenario (F-2 — does not exist).
- No Connector/ERPNext posting assertions (architecture invariant — DP-2 is the boundary).
- No 028 auth re-test (bound by reference; G10).
