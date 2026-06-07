# Phase 0 Research: Console Sync-Ops Read-Model v1

**Branch**: `025-console-sync-ops-read-model-v1` | **Date**: 2026-06-07

Each unknown is resolved to a decision with rationale and the alternatives rejected.

---

## R1 — How to treat the not-yet-built source domains (020 connector-health, 021 product-master reconciliation)

**Decision**: Define the full sync-ops read-model shape across all four domains, but
v1 **populates only the buildable 015 + 017 domains**. The 020/021 domains are
present in the contract with an explicit `not_available` `DomainSummary.status`,
wired when those specs are implemented.

**Rationale**: Only 015 (posting status) and 017 (reconciliation runs/reports) are
merged and readable in this repo today; 020 and 021 exist only as planning specs
(this same wave) — their data sources are not yet built (016 is on-hold). A user
story that aggregates a not-yet-built source cannot be independently tested (no
source state to seed) and would be an incoherent MVP slice. A forward-compatible
contract lets the Retail Tower Console build against a stable shape now, and mirrors
DP2's established deferral pattern (017's `STOCK-VIEW-CONTRACT` future-gate; the
`EMPTY_BIN_VIEW` placeholder).

**Alternatives rejected**:
- *Block v1 until 020/021 are built* — stalls the console indefinitely on not-yet-built sources.
- *Omit 020/021 entirely from the v1 shape* — forces a breaking contract change later
  when those domains land; the console would have to re-integrate.
- *Fabricate 020/021 as `0`/empty* — falsely asserts "checked, all clear"; an operator
  could not distinguish "healthy" from "never checked". Rejected as a correctness leak.

---

## R2 — Materialized projection (new table refreshed by a worker) vs compute-on-read

**Decision**: **Compute-on-read** — a read-through projection that recomputes per
request from current 015/017 state. **No new persistent table, no migration, no
materialized copy.**

**Rationale**: A materialized projection would (a) require a `[GATED]` migration and a
worker refresh path, (b) create a drift surface where the projection disagrees with the
source, and (c) violate the spirit of "no mirror" (§IX). Compute-on-read is the
established posture in 009 (compute-on-read on-hand) and 017 (`READ-NOT-MIRROR-015`),
keeps §IX literally true, and reduces the only gated surface to the OpenAPI contract.
The source tables already carry the right indexes for tenant-scoped status reads;
v1 read volume (operator dashboard) is low.

**Alternatives rejected**:
- *Materialized summary table* — drift + gated migration + worker, for no v1 benefit.
- *Redis-cached summary* — cache-as-truth risk (§III), invalidation burden; recompute
  is cheap enough at console cadence.

---

## R3 — Authentication / authorization scheme

**Decision**: **cookieAuth + `DashboardAuthGuard`** (human operator session) plus a
role gate (`RolesGuard`), rejecting machine credentials (`connectorBearer`,
`dashboard_api` bearer, POS `clerkJwt`).

**Rationale**: The console operator is a human; 017's `reconciliation.yaml` operator
contract already uses exactly this scheme for the equivalent surface, and 018
established the session-only-admin discipline (reject machine bearer on human surfaces).
Reusing it keeps the human/machine boundary crisp and avoids inventing a new auth
primitive.

**Alternatives rejected**:
- *`connectorBearer`* — that is the machine connector identity (012/018), not a human
  operator; wrong trust class.
- *A new bearer scheme for the console* — unnecessary; the dashboard cookie session
  already authenticates console humans.

---

## R4 — Read-only vs exposing repair/run-trigger through the read-model

**Decision**: **Strictly read-only.** 025 exposes no create/update/delete/trigger/
repair affordance. Repair and run-trigger remain 017's `reconciliation.yaml` write
operations.

**Rationale**: The spec context fixes 025 as a read-model with no new write surface and
no new authority. Folding a write into 025 would blur the 017↔025 carve (017 owns
run→report→repair writes) and re-open the no-mirror question. The console can call 017's
existing write operations directly for repair; 025 only consolidates the *view*.

**Alternatives rejected**:
- *Proxy 017's repair through 025* — duplicates a write surface, two contracts for one
  action, idempotency-key ownership ambiguity.

---

## R5 — Money handling in posting projections

**Decision**: **Pass-through** any monetary value as the stored exact-decimal with its
explicit currency code; never re-derive, re-round, or rewrite.

**Rationale**: §III forbids float money and mandates exact-decimal; §IX makes the
sale-line snapshot the historical truth and forbids silent rewrites of POS/sale totals.
A read-model must surface the stored value verbatim. The 008/010 `normalizeAmount`
posture (natural minor precision, never float) is the reuse target if any normalization
to wire form is needed.

**Alternatives rejected**:
- *Recompute totals in the read-model* — would diverge from the snapshot truth and risk
  a silent rewrite; forbidden.

---

## R6 — Pagination / list semantics for backlog + run-history

**Decision**: **Cursor-based, bounded, deterministically ordered** lists (opaque cursor;
default + max page size; stable sort key, e.g. dead-letter timestamp + id for the
backlog, run start time + id for history). Gap-detectable across pages.

**Rationale**: 017 and 010 already established cursor pagination + deterministic
ordering for operator/console lists; an unbounded scan to the console is forbidden
(§API conventions, performance). Reusing the pattern keeps the console's paging code
consistent.

**Alternatives rejected**:
- *Offset pagination* — non-gap-detectable under concurrent inserts; rejected.
- *Unbounded list* — forbidden; risk of huge responses.

---

## R7 — Observability surface

**Decision**: Reuse the **shared sync-ops signals** in the shared api metrics surface
(`apps/api/src/observability/metrics/api.metrics.ts`) — the §VII-named reconciliation mismatch
rate / POS sync lag family — rather than introducing a per-feature metrics file.
Structured logs carry `request_id` / `tenant_id`.

**Rationale**: §VII names these signals as expected; 010 explicitly registered its
signal in the *shared* `api.metrics.ts` (not a per-feature file) and that is the repo
convention. v1 adds at most lightweight read-path counters; no new dashboard family.

**Alternatives rejected**:
- *Per-feature metrics file* — fragmentation; contradicts the 010 lesson.

---

## R8 — Where the new code lives

**Decision**: A new sub-module `apps/api/src/catalog/erpnext-sync-ops/`, sibling to the
existing `erpnext-posting` (015) and `erpnext-reconciliation` (017) modules; routes
under `/api/v1/...`. No `packages/db` change, no worker change.

**Rationale**: 017 placed the operator reconciliation surface under
`apps/api/src/catalog/`; 015's posting state lives in `erpnext-posting`. Co-locating the
read-model with its sources keeps the read helpers close and the dependency direction
clean (025 reads from 015/017, never the reverse).

**Alternatives rejected**:
- *New top-level `apps/api/src/erpnext-sync-ops/`* — diverges from where the source
  modules live; weaker cohesion.
