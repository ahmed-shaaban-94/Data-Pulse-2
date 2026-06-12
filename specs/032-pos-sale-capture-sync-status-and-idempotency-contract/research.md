# Phase 0 Research — Spec 032 POS Sale Capture / Sync-Status / Idempotency

**SPECIFY-ONLY.** Decisions below are planning decisions, not code. No OpenAPI/migration/service code is authored. The four §13 owner decisions are recorded as OPEN and are NOT resolved here.

## Decision 1 — Reuse the live two-layer idempotency; engage L1 only

- **Decision**: Keep L2 atomic dedup exactly as shipped (`ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING`, F-4). Engage the existing platform `idempotency_keys` seam as L1 **on capture**, keyed per the Constitution's `(tenant_id, store_id, client_id, key)` + TTL contract, returning the prior response on replay.
- **Rationale**: L2 is LIVE and proven; rebuilding it risks regressing replay→same-sale behavior. L1 is the documented-but-unused seam; engaging it on capture closes the request-level idempotency gap without new infrastructure.
- **Alternatives considered**: (a) Rebuild dedup as a single layer — rejected, regresses live behavior and violates F-4. (b) Engage L1 across all POS write ops now — rejected, that scope is an OPEN owner decision (§13 item 2); plan engages capture-only.

## Decision 2 — Server-authoritative status is persisted, server-owned, server-clock-stamped

- **Decision**: DP-2 persists an authoritative sale-status it alone sets, distinct from the POS-local outbox UX state. Transitions are stamped on the server clock (Principle X). The terminal observes; DP-2 decides; POS never overrides (§7).
- **Rationale**: Principle III (backend authority) + IX (source-of-truth). A derived/projected-only status would let POS-local state leak into the authoritative view.
- **Alternatives considered**: Derive status purely from outbox rows — rejected; not authoritative, and the Console needs a stable server-owned vocabulary to consume.
- **Deferred forward**: exact column/enum/transition modeling → `data-model.md` (conceptual) then the implementation slice's migration `0025`.

## Decision 3 — Dead-letter classification: RETRYABLE vs NEEDS_REPAIR, never silent drop

- **Decision**: Non-retryable failures route to a NEEDS_REPAIR quarantine with provenance (028) intact; transient/5xx failures are RETRYABLE with backoff (§8 table, mapped to Spec-029 §6). Reconnect-auth-failure classification routes to 028 OQ-5. No silent drop (Principle V, XIII).
- **Rationale**: Constitution Principle V requires dead-letter surfaces with alerting; XIII requires provenance preserved. The §8 table already fixes the taxonomy; this decision is about wiring it to the existing worker/outbox dead-letter surface.
- **Alternatives considered**: Drop-on-max-retries — rejected, forbidden by Principle V.

## Decision 4 — `sale.captured` is verified/bound, not re-registered

- **Decision**: Treat `SALE_CAPTURED: "sale.captured"` as already in `OUTBOX_EVENT_TYPES` (F-5). Scope is to verify the producer is **bound** and emits **in-transaction** during capture, and that a consumer drains it to advance status. Do NOT plan a registration PR.
- **Rationale**: F-5 is a verified fact; re-registration would be a no-op at best and drift at worst.
- **Alternatives considered**: Register a new event type — rejected, violates F-5.

## Decision 5 — Read/repair surface is generated-client-only; repair is server-mediated

- **Decision**: The §9 surface (sync-status read, NEEDS_REPAIR list, sale/receipt lookup, audit/correlation timeline, repair/retry) is exposed as a generated client consumed later by the Console. Repair acts only on DP-2-classified NEEDS_REPAIR, is audited, and is never a sale-fact rewrite. No POS-local override path is designed.
- **Rationale**: Principle XII (object safety, default-deny) + XIII (audited). Keeps the architecture invariant (Console → DP-2, never Console → ERPNext).
- **Deferred forward**: final repair-authority confirmation is an OPEN owner decision (§13 item 3 / 029 Q11 / 028 OQ-2).

## Decision 6 — No server settlement; keep live 409

- **Decision**: This contract covers capture / sync-status / idempotency / refusal / dead-letter ONLY. No `payments.confirm`/`settled_at` endpoint (F-2). The live provenance-conflict `409` (`TerminalEventProvenanceConflictError`) is preserved everywhere; any `422` is additive and owner-gated.
- **Rationale**: F-2 (settlement is POS-local) and F-3 (no 409 regression) are hard constraints; the AlreadyApplied-422 question is an OPEN owner decision (§13 item 1).

## Open owner decisions (recorded, NOT resolved)

1. AlreadyApplied 422 vs keep-409 (F-3) — left OPEN; plan keeps 409 live, sequences 422 after the read/status slice.
2. L1 engagement scope (capture-only vs all POS write ops) — left OPEN; plan engages capture-only.
3. Repair authority (Console-mediated, no POS-local override v1) — left OPEN.
4. `sales.yaml` ops contract-first vs alongside service work — left OPEN.
