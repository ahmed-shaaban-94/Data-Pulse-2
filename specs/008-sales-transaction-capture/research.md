# Phase 0 Research: Sales / Transaction Capture (008)

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Gate**: [gate-money-temporal.md](./gate-money-temporal.md)

**Status**: No open NEEDS CLARIFICATION. The Money + Temporal Decision Gate is RESOLVED (2026-05-30), so Phase 0 records the **settled decisions** (Decision / Rationale / Alternatives) rather than open research. Each maps to a gate item and/or a spec FR.

---

## R1 — Transaction money precision (gate A.1 / FR-005)

- **Decision**: All transaction monetary fields use `numeric(19,4)` with an ISO-4217 currency code — identical to the 003 catalog money.
- **Rationale**: One money model across catalog and sale; no precision boundary between line amounts and totals where silent rounding could occur. 4 decimals cover sub-unit/weighed/fuel pricing; 15 integer digits is ample headroom.
- **Alternatives considered**: split scale (lines `(19,4)`, totals `(19,2)`) — rejected: introduces a rounding boundary that complicates A.3 and risks spurious mismatch flags.

## R2 — Line-tax representation (gate A.2)

- **Decision**: A single **per-line tax amount**, stored as a snapshot of what the POS charged. The SaaS never recomputes tax.
- **Rationale**: Faithful to §III "preserve what the POS charged"; minimal schema; no risk of the SaaS overwriting POS-charged values.
- **Alternatives considered**: rate+amount (invites recompute → §III risk); structured multi-tax breakdown (heavier; only justified for multi-tax jurisdictions — deferred to a later feature if a market needs it).

## R3 — Rounding for the SaaS comparison total (gate A.3/A.4 / FR-031)

- **Decision**: **Per-line rounding, half-up**, for the SaaS-computed comparison total only. The POS-reported total is preserved verbatim regardless (FR-030).
- **Rationale**: Matches typical retail POS receipts and human expectation → fewest false mismatch flags. Aligns the advisory comparison to the dominant POS rule.
- **Alternatives considered**: invoice-level rounding (may disagree with displayed line amounts → spurious flags); banker's/half-even (accounting-style, less common in retail POS).

## R4 — Tender / change / multi-tax (gate A.5 / FR-101, SI-009)

- **Decision**: **Deferred to the payments feature (010).** 008 persists the sale fact + POS-reported total only; **no tender persistence in v1.**
- **Rationale**: Keeps 008 focused on the immutable sale fact; avoids pulling payment-class PII (§XIV) into the first sale slice. Payments are contract-only / POS-Pulse-side today.
- **Alternatives considered**: include tender now — rejected: widens scope into §XIV classification + a payments contract that does not yet exist on the backend.

## R5 — Money representation / library (gate A.6 / Constitution Follow-up TODO #1)

- **Decision**: A **string-backed money value object** (`{ amount: string, currency }`, validated at the Zod boundary, round-tripped to DB `numeric(19,4)`). **No new dependency.**
- **Rationale**: No float ever appears; portable, explicit. Because R2 chose snapshot tax, the SaaS does almost no money arithmetic (only the R3 comparison total), so a big-decimal library is unwarranted — **no `[GATED]` `package.json` add is required** (plan §10).
- **Alternatives considered**: `big.js`/`decimal.js` — rejected for v1: ergonomic arithmetic isn't needed at this scope, and it would trigger a gated dependency approval. (If `/speckit-tasks` later finds the comparison math genuinely needs it, that becomes a separate `[GATED]` decision.)

## R6 — Per-entity timestamp required/optional (gate B / FR-020)

- **Decision**: NOT NULL — `occurredAt`, `receivedAt`, `businessDate` on `sales`; `voidedAt`/`refundedAt` on their terminal events. Nullable — `processedAt` (null-until-processed), `sourceClockAt` (POS may omit). `sale_lines` **inherit** the parent sale's `occurredAt`/`businessDate` (no own copy). All timestamps `TIMESTAMPTZ` in UTC.
- **Rationale**: Strong invariants on server-owned + business-critical times, while tolerating partial/offline POS payloads so legitimate delayed events are never rejected (§X). `processedAt` is nullable-until-processed because forcing it NOT NULL would force synchronous processing (against §V).
- **Alternatives considered**: only `receivedAt` required (too weak — null-handling everywhere); all-required-except-`processedAt` (risks rejecting events from a POS that omits `sourceClockAt`, violating §X "delayed/partial events MUST NOT be rejected").

## R7 — Payload-hash algorithm (gate C / FR-040)

- **Decision**: **SHA-256 over canonical JSON (sorted-key / JCS), hashing the full payload.**
- **Rationale**: SHA-256 is the constitution's own suggestion and ubiquitous; canonical JSON makes the *same logical payload* hash identically across cosmetic re-serialization, keeping provenance reconciliation-stable across re-deliveries.
- **Alternatives considered**: hash raw received bytes (byte-fragile — whitespace/key-order differences break the match); SHA-512/BLAKE3 (no material benefit for provenance).

## R8 — Concurrency posture (gate D.1 / FR-070/071)

- **Decision**: A captured sale is an **immutable historical fact**. Concurrency control = **idempotent dedup on `sourceSystem + externalId`**; **no** optimistic-concurrency `version` column; corrections are **append-only** void/refund terminal events. The only mutable surface is SaaS-owned processing state (`processedAt`, advisory mismatch flag), written idempotently off-request.
- **Rationale**: A version column on an append-only fact table is meaningless. §III requires LWW/posture to be justified when chosen; dedup-as-concurrency is the correct control for at-least-once POS delivery, and this is that justification.
- **Alternatives considered**: optimistic `version` + `If-Match` (no mutable business state to guard); last-write-wins (would permit silent overwrites of an immutable fact — forbidden).

## R9 — Per-tenant bulk-sync bound (gate D.2 / FR-080, SI-011)

- **Decision**: Offline-recovery batch ceiling **500 sale events per request**, layered on the inherited 001/004 platform rate-limit posture. No unbounded batch path.
- **Rationale**: A documented bound MUST ship with the first ingestion-heavy feature (Per-Tenant Resource Isolation) so one tenant's recovery burst cannot starve others. 500/request is a conservative starting ceiling for offline catch-up without unbounded memory/latency. Values are initial defaults, tunable in `tasks.md` without re-opening the gate.
- **Alternatives considered**: unbounded batch (noisy-neighbor risk); a tiny ceiling (forces excessive round-trips on recovery).

## R10 — Sale-fact data classification + retention (gate D.3 / SI-012, §XIV)

- **Decision**: Sale-fact entities are **business-class** (catalog references + quantities + POS-reported totals; no customer identity in v1). Retention **inherits the 001 long-horizon, insert-only audit-retention posture** for the immutable fact. Right-to-erasure tombstones any future PII field rather than deleting the fact.
- **Rationale**: With tender deferred (R4), the sale fact holds no PII/payment data, so business-class is correct. Reclassification re-triggers (to PII/payment-class) if customer-reference or tender data is later admitted (SI-012).
- **Alternatives considered**: treat as PII-class from day one (over-classification — no PII present in v1).

## R11 — Reused platform seams (no research; reuse-as-is, FR-050/051/060/081/090)

- **Decision**: 008 reuses, unchanged: the `Idempotency-Key` interceptor (`apps/api/src/idempotency/`), tenant-context + RLS via `with-tenant.ts` / `tenant-context.ts`, audit via `audit-insert.ts`, async via `outbox/producer.ts`, and the `posCaptureItem` POS-route pattern (`@Post("api/pos/v1/...")`, no `@Controller` prefix arg).
- **Rationale**: These are shipped and proven by 005; reusing them satisfies §V/§XI/§II/§XIII with no new primitive. 008's only new surface is the sale-fact schema + OpenAPI contract (both `[GATED]`).
- **Alternatives considered**: a bespoke ingestion path — rejected (re-invents proven plumbing, divergence risk).
