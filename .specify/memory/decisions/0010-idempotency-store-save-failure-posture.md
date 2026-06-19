# ADR 0010 — Idempotency Store Save-Failure Posture

**Status**: Accepted
**Date**: 2026-06-19
**Ratified**: 2026-06-19 (owner)
**Owner**: Owner (Ahmed Shaaban)
**Constitution version**: (current)
**Feature / Ref**: Audit finding **M-5** (super-deep audit, 2026-06-19) · `apps/api/src/idempotency/idempotency.interceptor.ts` · related [ADR 0009](0009-pos-write-endpoint-rate-limiting.md) D3 (same Redis-outage axis) · Orchestrator audit-fix report `docs/status/audit-fix-pass-2026-06-19.md`

---

## Context

The 2026-06-19 super-deep audit (finding **M-5**) observed that the idempotency
interceptor persists its replay record **best-effort**. Verified against `origin/main`
(`apps/api/src/idempotency/idempotency.interceptor.ts:377-385`):

```ts
await this.store.save(tId, null, cId, tuple, _fp, result, expiresAt)
  .catch(() => undefined); // best-effort
```

If `store.save` fails (Redis outage, network partition), the handler's response is still
returned to the caller, but **no replay record is persisted**. A subsequent retry with the
same `Idempotency-Key` finds no stored entry and **re-executes the handler** — a potential
duplicate side effect.

**The harm is asymmetric across write paths, and the code self-documents it** (verified on
`origin/main`, not inferred from the audit):

- **Sales have a second dedup layer.** `sales.controller.ts` handles a *"Provenance
  dedup-hit"* via `TerminalEventProvenanceConflictError` on the `(sourceSystem, externalId)`
  unique key (FR-013/FR-100). A sale that slips past the interceptor still hits a DB-level
  provenance conflict → no duplicate.
- **Settlement intents have NO second layer.** `receivable.service.ts:13-17` states
  verbatim: *"this slice's intent has NO per-row dedup key ... NOT idempotent on its own — a
  replay reaching it inserts duplicate rows"*, and `settlement.controller.ts:27`: *"the
  service has no per-row dedup key."* Its **only** dedup defence is the interceptor replaying
  the stored 201. If the save is the operation that silently failed, that defence is gone.

So during a Redis-outage window, a settlement-intent retry can **insert duplicate receivable
rows** — a money-domain correctness defect — while the same failure on a sale is absorbed by
provenance dedup.

This touches money representation + replay-safety (the ADR template's "Critical" trigger),
so it is recorded as an ADR. It shares the **Redis-unavailable axis** with [ADR 0009](0009-pos-write-endpoint-rate-limiting.md)
D3 (rate-limiter fail-open); the two MUST be decided coherently and are cross-referenced.

---

## Decisions

### D1. On idempotency `store.save` failure: **emit a metric/alert; do NOT silently swallow** — keep the response, surface the degradation

Replace the bare `.catch(() => undefined)` with a `.catch` that **records a metric/alert**
(idempotency-save-failure counter + structured warn log) before returning. The handler
response is still returned to the caller (no behaviour change on the happy path), but the
degraded state becomes **observable** so operations can detect that idempotency is silently
weakened during a Redis outage.

| Alternative considered | Ruled out because |
|---|---|
| **Keep silent best-effort (status quo)** | A Redis outage degrades replay-safety with zero signal — duplicate settlement rows could accumulate undetected. The audit's exact concern. |
| **Hard-fail the request (503) on save failure** | Converts a *replay-safety* datastore outage into a *write* outage — the request already succeeded server-side; rejecting it after the fact is the wrong failure mode for POS-first availability, and is incoherent with ADR 0009 D3 (fail-open). It also does not actually prevent the duplicate — the side effect already happened; the 503 just hides that it did. |
| **Metric/alert + keep response (chosen)** | Lower-regret: preserves availability (matching 0009 D3), does not pretend the operation failed, and makes the degraded window visible so the real risk (duplicate settlement intents) can be watched and bounded. |

- **Tradeoff**: this makes the degradation *visible* but does not by itself *prevent* a
  duplicate settlement intent during the outage window. The structural prevention is D2.

### D2. Close the settlement-intent dedup gap at the **domain layer**, not by hardening the interceptor alone

The asymmetry exists because settlement intents lack the provenance dedup that sales have.
The durable fix is to give the settlement-intent path its **own** replay-safety that does
not depend on Redis being up — e.g. a natural dedup key (a deterministic intent
`(tenant, sourceSystem, externalId)`-style unique constraint, mirroring the sales
provenance pattern) so a replay that re-reaches the service is rejected at the DB, exactly
as a sale is.

- **Tradeoff**: this is a schema/contract-adjacent change (a new unique key or dedup column
  on the settlement-intent path) and is therefore **gated** — it is named here as the
  correct direction, not authored. It requires its own spec/migration slice and owner
  approval. D1 (observability) is the immediate, ungated mitigation; D2 is the durable fix.

### D3. The Redis-outage posture MUST match ADR 0009 D3 (observe-and-degrade, not hard-fail)

ADR 0009 D3 decided that the rate limiter **fails open + alerts** on Redis outage. This ADR
adopts the **same posture** for idempotency-save failure (D1): keep serving, surface the
degradation, do not hard-fail. Deciding these two incoherently (e.g. rate-limit fails open
but idempotency 503s) would produce contradictory behaviour on a single Redis outage. They
are explicitly bound.

---

## Hard out-of-scope

This ADR decides **posture + direction**; it authors no implementation.

- It does **not** edit `idempotency.interceptor.ts`, the `store.save` call, or any
  metric/alert wiring (D1 is a gated impl slice; the metric path also depends on the
  AD-TOOL-003 observability layer being active).
- It does **not** author the settlement-intent dedup key / migration / contract change (D2
  is a separate, gated spec+migration slice).
- It does **not** change the sales provenance-dedup path (already correct).
- It does **not** alter idempotency behaviour on the happy path (Redis healthy).

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| Money representation / correctness | strengthened — prevents (D2) / surfaces (D1) duplicate settlement-intent rows |
| Idempotency & replay-safety (G5) | strengthened — closes the Redis-outage replay gap on the settlement path |
| Availability of selling (POS-first) | preserved — D1 keeps serving rather than 503-ing on a replay-store outage (coherent with ADR 0009 D3) |
| Observability | strengthened — the degraded state becomes a signal instead of silent |

---

## Open Questions

1. **D1 metric/alert wiring depends on the AD-TOOL-003 observability layer** being
   activated (Sentry/Datadog default-inert until approved). Until then, D1 lands as a
   structured warn log at minimum.
2. **D2's dedup-key shape** — confirm whether the settlement intent already carries a
   deterministic `(tenant, sourceSystem, externalId)`-equivalent that can back a unique
   constraint, or whether the contract must add one (the latter is OpenAPI-gated).
3. **Coherence with ADR 0009** — both Redis-outage postures (rate-limit D3, idempotency D1)
   must ship as one coherent decision; do not implement one fail-open and the other
   hard-fail.

---

## References

- Audit finding **M-5** — `audit-report.md` (independent audit, 2026-06-19)
- Orchestrator audit-fix report — `docs/status/audit-fix-pass-2026-06-19.md` (Retail-Tower-Orchestrator)
- `apps/api/src/idempotency/idempotency.interceptor.ts:377-385` — the best-effort `store.save` (verified on `origin/main`)
- `apps/api/src/settlement/receivable.service.ts:13-17` + `settlement.controller.ts:27` — the self-documented "no per-row dedup key" gap
- `apps/api/src/catalog/sales/sales.controller.ts` — the provenance dedup layer sales have and settlement intents lack
- [ADR 0009](0009-pos-write-endpoint-rate-limiting.md) D3 — the bound Redis-outage posture
