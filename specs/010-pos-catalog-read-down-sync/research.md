# Research — 010 POS Catalogue Read-Down Sync (Phase 0)

Resolves the spec's deferred decision (delta mechanism) and sets the remaining technical unknowns. Format: Decision / Rationale / Alternatives.

---

## R1 — Delta mechanism: change-log / projection-version (REQUIRED; needs a gated migration)

**Decision**: Serve deltas from a **catalogue change-log keyed by a per-`(tenant, store)` monotonic cursor** (a dedicated sequence/version, outbox-style). The snapshot's opaque cursor (FR-011) is this sequence value; `deltas?since=<cursor>` returns change rows after it, including explicit **removal tombstones**. This requires an **additive `[GATED]` migration** — 010 does **not** stay schema-free.

**Rationale (empirically grounded)**:
- The 003 catalog tables carry `updated_at`, `created_at`, `retired_at` but **no monotonic version column** (verified: `tenant-products.ts`, `store-product-overrides.ts`).
- **Deriving deltas from `updated_at` fails the contract on two counts:**
  1. **Ordering/gap-detection (FR-022)** — wall-clock `updated_at` has tie/skew risk and no gap signal; a consumer can't prove it missed nothing. A monotonic sequence gives total order + gap detection for free.
  2. **The removal tombstone (FR-042 / Decision #3)** — a product that *becomes* unpriced (price set NULL / currency dropped / non-representable) does **not** `retire`; the row stays active in 003, it merely stops qualifying for the *sellable* stream. There is **no row-state on the 003 tables that expresses "left the sellable stream."** `updated_at` cannot represent this transition as a removal. A change-log can emit a `remove_from_sellable` tombstone explicitly.
- The repo already has an **`outbox_events`** pattern (verified: `packages/db/src/schema/outbox_events.ts`) — a proven monotonic change-event mechanism to mirror, reducing novelty.
- Cursor is **opaque** to the consumer (FR-011), so this choice stays invisible across the contract — the spec's clarify deferral was correct; the plan is the right place to land it.

**Migration shape (for the gated slice — NOT authored here)**: additive only — a catalogue change-log table capturing upsert + `remove_from_sellable` events with a **single per-tenant monotonic sequence** (see R9 for the fan-out decision), populated when sellable-relevant fields change (price, currency, availability, retire, name/alias/tax). Reviewed for lock duration + rollback (Backend Authority). No change to existing 003 column semantics.

**Alternatives considered**:
- *Derive from `updated_at`/`row_version`* — rejected: cannot express the removal tombstone (FR-042); ordering/gap-detection fragile. (This was the *delta-mechanism* "Option B" — distinct from, and unrelated to, the 2026-06-03 R-1 **payload** "Option B" recorded in spec.md Clarifications.)
- *Hybrid (upserts from `updated_at` + tombstone log only)* — rejected for v1: two mechanisms with two consistency models; the single change-log subsumes it more simply and matches the existing outbox pattern.
- *Full event-sourcing of the catalogue* — rejected: out of scope; the change-log is a projection-versioning aid, not a new SoT.

---

## R2 — Cursor semantics

**Decision**: Server-issued **opaque, monotonic, scope-bound** cursor (encodes `(tenant_id, sequence)`; opaque to the client — the store scope is applied at read time via the R9 union filter, NOT encoded in the token). Snapshot returns the current cursor; delta advances it. A cursor older than the retained change-log horizon → `snapshot_required`. A cursor presented under a different scope → non-disclosing rejection (FR-024). (Per-tenant sequence + sentinel-row fan-out is fixed in R9.)

**Rationale**: Opaqueness lets the mechanism (R1) evolve without a contract break; monotonic + scope-bound gives deterministic ordering and isolation. No client wall-clock dependence (immune to terminal clock skew).

**Alternatives**: client-supplied timestamp cursor — rejected (skew, not gap-detectable, leaks mechanism).

---

## R3 — Conflict / duplicate-event policy (Constitution §IV requires it documented)

**Decision**: **Read-only, so no write-conflict policy applies.** The "duplicate event" rule (§IV) is: **re-requesting the same `since` cursor is idempotent** (FR-021) — identical logical change set, safe to re-apply; the consumer applies upserts/removals idempotently by `product_id`. There is no last-write-wins/version-vector concern because the terminal never writes back.

**Rationale**: §IV's conflict-awareness clause targets entities editable by *both* sides; this entity is platform-authoritative and POS-read-only, so the only "conflict" surface is replay, handled by cursor idempotency.

---

## R4 — Money representation + lossless conversion guarantee

**Decision**: Emit `price: { amount: <exact-decimal string, ≤4dp DecimalAmount>, currency_code }` at the **currency's natural minor precision** (EGP ≤2dp). **Platform guarantee**: a sellable row's `amount` is always representable in the currency's minor unit (the sellable filter R5 excludes any that isn't). The consumer (POS-Pulse) converts to integer minor units by string decimal-point shift × currency minor exponent — no float, reject if more fractional digits than the minor unit allows.

**Rationale**: Matches the existing `DecimalAmount` contract + §"Money" (no float). Pushing the representability filter to the *source* (R5) means the consumer's conversion never legitimately fails — a failure at the consumer signals real data corruption, not normal variance.

**Alternatives**: emit minor-units integer directly — rejected: contradicts the platform's decimal-string discipline and couples the contract to a single minor-exponent assumption.

---

## R5 — Sellable-stream filter (the null-price exclusion)

**Decision**: A row is in the sellable stream iff: `retired_at IS NULL` AND resolved `is_active`/availability true AND **price present AND currency present AND representable in the currency minor unit**. Anything failing the price/currency/representability test is **omitted** from snapshot + upsert deltas, emits a `remove_from_sellable` delta if it was previously sellable (R1), and is recorded to the unpriced-issue signal + backlog (R6).

**Rationale**: Decisions #2/#3 + FR-040–044. Source-side filter is the first layer of the two-layer defense (consumer rejection is the second).

---

## R6 — Unpriced-issue surfacing (signal + data, no new admin UI)

**Decision**: Emit (a) an **observability counter** (`catalog_unpriced_issue_rate`, extending the 003 §9 family) and (b) **backlog data** consumable by an existing/future reconciliation surface (005/006/007 family). **This feature builds NO admin screen** (clarified; FR-043, §3 Non-Goals).

**Rationale**: Keeps the read-only feature read-only; the correction workflow already has a home in the reconciliation features.

---

## R7 — Integrity / signing

**Decision**: v1 = **TLS + device-auth**, optional response **content-hash/ETag** for change detection. Detached snapshot signing (003 PQ-6) named, deferred, with a documented upgrade path; does not block v1.

**Rationale**: 003 PQ-6 deferred signing to this feature's own discretion; TLS + device-principal is sufficient for the internal/dev rollout; ETag is a cheap change-detection win.

---

## R8 — Transport / pagination / performance

**Decision**: JSON + gzip; snapshot **cursor-paginated** (`next_page_token`) with all pages reflecting one consistent cursor point; inline JSON (not fetch-by-URL) for v1. **Performance**: snapshot/delta are latency-tolerant (the offline replica absorbs latency; not per-scan). Set **server-side p95 targets at the gated impl slice** measured against a ~50k-product store (the scale POS-Pulse 009 T054 measured). No hard per-request SLA pinned at spec level — this is a bulk read, not the latency-critical per-scan path (003 §4 rejected per-scan as primary).

**Rationale**: Bulk pull at predictable per-change-wave cost (003 §4.3); pagination bounds memory on both ends at 50k scale.

---

## R9 — Change-log fan-out for tenant-level changes (resolves external-review R-3)

**Context**: A change to a *tenant-level* field (e.g. `tenant_products.default_price`, `name`, `tax_category`) affects the resolved view of **every store that does not override that field**. R1 keyed the change-log "per `(tenant, store)`", which forced a decision: how does one tenant-product UPDATE become per-store change-log entries?

**Decision — single per-tenant sequence + tenant-wide (`store_id IS NULL`) sentinel rows; a deliberately *dumb* trigger.**

1. **One monotonic `sequence` per `tenant_id`** (NOT per `(tenant, store)`). This supersedes the data-model §2/§3 "per tenant+store" wording (corrected there).
2. **Fan-out = NONE at write time.** A tenant-level change writes **one** row with `store_id IS NULL`. A store-override change (`store_product_overrides`) writes one row with `store_id = S`. An alias change writes one row scoped as the alias is scoped (tenant-wide alias → `store_id IS NULL`; store-scoped alias → `store_id = S`).
3. **Delta query filters** `tenant_id = T AND (store_id = S OR store_id IS NULL) AND sequence > C`, ordered by `sequence`. The store sees its own override events **unioned with** tenant-wide events.
4. **The trigger does NOT consult `store_product_overrides`** to decide which stores "really" changed. It is a one-row-per-raw-table-change insert. Correctness of "did store S's resolved view actually change?" lives in the **read-side resolver + idempotent application** (next point), not in the trigger.
5. **Override-masking is handled as a harmless idempotent re-upsert** (resolves the §3 gap the external review flagged): if a tenant-level field changes but store S overrides that exact field, S still receives the tenant-wide `upsert` event; applying it re-writes S's resolved row to the **same** value it already held (the resolver computes Tenant ⊕ Override, the override still wins). FR-021 idempotency makes this a no-op for the consumer. No write-time override-consultation is needed.

**Rationale**:
- **The change-log carries only `product_id` + `op`, never payload** (data-model §3); the resolved `row` is computed at *read* time per `(tenant, store)` regardless (§4). So write-time fan-out would pre-resolve **nothing** — it would only multiply inserts (N = store count per tenant-level change) and force an override-aware, high-amplification trigger. Pure cost, no benefit.
- **R8 governs over R1's "dense sequence" lean.** Reads are latency-tolerant (offline replica absorbs latency); the design should favor **light writes + heavy reads**. The sentinel is one insert per change vs. N; the read does a slightly wider filtered scan — exactly the right trade at the ~50k-product, multi-store scale.
- **FR-022 "gap-detectable" = server-guaranteed completeness**, NOT consumer-verified cursor contiguity. The delta contract guarantees "all rows `> C` for this store's filter are returned"; the consumer does NOT prove completeness by sequence density. A per-tenant sequence is therefore *sparse* for any single store (e.g. 5, 9, 12) and that is correct and expected — gaps are other stores' events, not missing data. (A per-store dense sequence would be the only design requiring consumer-side contiguity checking; it is not chosen.)
- **Single sequence preserves total order** for a product changed twice in quick succession (tenant-wide then store-override) — two interleaved per-scope streams would lose that ordering. One sequence keeps it.
- Invisible across the **opaque** cursor (FR-011): this entire mechanism choice is internal; the consumer and acceptance tests never see it, so it is correctly a plan/research-level decision, not a contract change.

**Alternatives considered**:
- *Per-store fan-out (dense per-`(tenant,store)` sequence, N inserts per tenant-level change)* — rejected: write-amplification with zero read-time benefit (payload already resolves at read); requires an override-aware trigger; only justified if FR-022 demanded consumer-verified contiguity, which it does not.
- *Two interleaved sequences (tenant-wide + per-store)* — rejected: loses total order across the two streams for the same product.

**Lock/perf note for the gated `010-SCHEMA` slice (T013)**: with the sentinel, the worst-case write is **one** change-log INSERT per raw catalog UPDATE — no per-store amplification — so the trigger's lock footprint on `tenant_products` / `store_product_overrides` / `product_aliases` is bounded and additive. The delta read adds a `(store_id = S OR store_id IS NULL)` predicate; index the change-log on `(tenant_id, sequence)` with `store_id` as an included/filter column.

---

## Resolved → into Phase 1

R1/R2/R9 → data-model (change-log/cursor entity + tombstone + per-tenant sequence/sentinel fan-out). R4/R5 → data-model (sellable projection + money). R3 → contracts (idempotent replay). R6 → contracts + observability. R7/R8 → contracts (headers, pagination). No NEEDS CLARIFICATION remain; external-review R-1 (payload) + R-3 (fan-out, R9) resolved.
