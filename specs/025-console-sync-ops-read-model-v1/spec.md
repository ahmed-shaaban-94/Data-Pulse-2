# Feature Specification: Console Sync-Ops Read-Model v1

**Feature Branch**: `025-console-sync-ops-read-model-v1`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "Console sync-ops read-model v1"

> **Arc context (grounding, not a clarification).** The **Retail Tower Console** is a
> sibling admin-UI repository (React 19 + Vite SPA) that consumes Data-Pulse-2 (DP2)
> exclusively through DP2's OpenAPI contracts. Today the console must hit several
> *separate* operational surfaces to understand the health of the ERPNext sync: the
> 015 posting feed/ack state (`erpnext_posting_status`), the 017 reconciliation
> runs/reports/repairs (`erpnext_reconciliation_*`), and — once they exist — 020
> connector health/status and 021 product-master reconciliation. **025 is a
> READ-MODEL (v1): a single console-facing read-through projection that aggregates
> these operational signals into one cohesive "sync-ops" view** so the console can
> render an operator dashboard without stitching four contracts together client-side.
>
> 025 introduces **NO new write surface, NO new authority, and NO mirror**. It is a
> compute-on-read projection over *existing* DP2 state (the 017 `READ-NOT-MIRROR-015`
> discipline and the 009 compute-on-read posture), never a stored copy. It owns **no
> new persistent table and no migration**. Authentication is **cookieAuth /
> `DashboardAuthGuard`, human-only** (the console operator is a human; this is NOT the
> machine `connectorBearer` and NOT POS `clerkJwt`), mirroring 017's
> `reconciliation.yaml`.
>
> **Source-availability reality (drives the story structure).** Of the four named
> source domains, only **015 (posting status) and 017 (reconciliation runs/reports)
> are merged and readable in this repo today.** **020 (connector health) and 021
> (product-master reconciliation) are future specs that do not yet exist** (016 is
> on-hold; 019–024 are unwritten). v1 therefore **defines the full sync-ops read-model
> shape across all domains but populates only the 015 + 017 domains**; the 020/021
> domains are present-but-deferred with an explicit "source not yet available" state,
> to be wired when those specs land. This forward-compatible shape gives the console a
> stable contract now without blocking on unwritten specs (the repo's established
> deferral pattern — cf. 017's `STOCK-VIEW-CONTRACT` future-gate and `EMPTY_BIN_VIEW`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator sees one consolidated sync-ops health summary (Priority: P1) 🎯 MVP

A **Tenant Admin / finance operator** opens the console's "ERPNext Sync Ops" page and,
in a single request, sees a consolidated health summary for their tenant: how many
sale postings are healthy (`posted` / `pending`) vs **dead-lettered**
(`permanently_rejected`) per the 015 posting status, the most recent reconciliation
run's outcome and any open mismatch counts per the 017 reports, and — for the
not-yet-available domains (connector health, product-master reconciliation) — an
explicit `not_available` domain status rather than a missing or fabricated number.
The summary is scoped to the operator's tenant (filterable by store) and is purely a
read: it triggers nothing, mutates nothing.

**Why this priority**: This is the MVP and the reason 025 exists. Each underlying
surface is already individually queryable, but the console today must call several
contracts and reconcile their shapes client-side to answer the one question an
operator actually asks — "is my ERPNext sync healthy right now, and if not, where?"
A single aggregated summary delivers that value immediately on top of already-merged
015 + 017 data, and is independently shippable.

**Independent Test**: Seed a tenant with a mix of `posted` / `pending` /
`permanently_rejected` posting rows (015) and at least one completed reconciliation
run with mismatch results (017); call the summary endpoint as that tenant admin;
confirm the response reports correct posting-health counts, the latest run's outcome
and open-mismatch count, and a `not_available` status for the connector-health and
product-master domains — all scoped to that tenant only.

**Acceptance Scenarios**:

1. **Given** a tenant with 5 `posted`, 2 `pending`, and 3 `permanently_rejected`
   posting rows plus one `completed` reconciliation run with 4 mismatch results,
   **When** the operator requests the sync-ops summary, **Then** the response shows
   posting health `{posted:5, pending:2, dead_lettered:3}`, the latest run as
   `completed` with `open_mismatches:4`, and the connector-health and
   product-master domains each as `status: not_available`.
2. **Given** dead-letters and runs across two tenants, **When** operator A requests
   the summary, **Then** only tenant A's counts and run appear (tenant isolation; a
   cross-tenant resource is non-disclosing — the summary never reveals tenant B's
   existence or volume).
3. **Given** the operator filters by a specific store, **When** the summary is
   requested with that store filter, **Then** posting and reconciliation counts
   reflect only that store's slice, consistent with the underlying 015/017 store
   scoping.
4. **Given** a tenant with no posting rows and no reconciliation runs at all,
   **When** the summary is requested, **Then** the response returns zeroed/empty
   domain summaries (not an error), with the deferred domains still `not_available`.

---

### User Story 2 - Operator drills into the posting dead-letter backlog through the read-model (Priority: P2)

From the consolidated summary, the operator drills into the **posting dead-letter
backlog**: a paginated, sortable, class-grouped list of the sales (and void/refund
reversals) whose ERPNext posting **permanently failed** (015 `permanently_rejected`),
each carrying its mismatch class, the originating sale/terminal-event reference and
its provenance (`sourceSystem` + `externalId`), the structured rejection reason, and
when it dead-lettered. This is the same backlog 017 surfaces, **re-projected through
the unified read-model wire shape** so the console renders it consistently with the
rest of the sync-ops view — it is a read-through, never a second copy of the data.

**Why this priority**: The summary (US1) answers "is it healthy?"; the backlog drill
answers "what exactly is broken, and why?" — the next thing an operator needs. It is
P2 because US1 already delivers standalone triage value, and the drill-down builds
directly on the surfaced summary and the already-merged 017/015 dead-letter
projection. The read-model does **not** expose repair here — repair is a write and
remains 017's `reconciliation.yaml` operation; 025 stays read-only.

**Independent Test**: Seed a tenant with `permanently_rejected` posting rows of mixed
classes plus healthy rows; call the read-model backlog list as the tenant admin;
confirm only that tenant's dead-letters appear, correctly classified, with provenance
and reason, paginated/sortable/groupable by class, and that `posted`/`pending` rows
are absent.

**Acceptance Scenarios**:

1. **Given** a tenant with three `permanently_rejected` rows (`unmapped_item`,
   `unmapped_store`, `validation`) and two healthy rows, **When** the operator lists
   the read-model backlog, **Then** exactly the three dead-letters are returned, each
   with class, originating reference, provenance, structured reason, and dead-letter
   timestamp; the healthy rows are absent.
2. **Given** a backlog larger than one page, **When** the operator pages and
   sorts/groups by class, **Then** results are stable, complete, and gap-detectable
   across pages (cursor-based, deterministic ordering).
3. **Given** dead-letters across two tenants, **When** operator A lists the backlog,
   **Then** only tenant A's rows are visible (cross-tenant non-disclosure).
4. **Given** the read-model backlog list, **When** the operator inspects any item,
   **Then** the wire shape is an explicit projection (no raw DB entity, no internal
   columns, no credential material) and exposes no write/repair affordance.

---

### User Story 3 - Operator reviews recent reconciliation run history through the read-model (Priority: P3)

The operator reviews a **list of recent reconciliation runs** for their tenant (the
017 run history) through the unified read-model: each run's trigger source, status
(`pending` / `running` / `completed` / `failed`), start/finish timestamps, and a
mismatch-summary count by class, with the deferred domains' run-equivalents reported
as `not_available`. This lets the operator answer "when did we last reconcile, did it
finish, and is the situation improving or worsening across runs?" without leaving the
sync-ops view.

**Why this priority**: Run history is operationally valuable but the lowest-urgency of
the three — an operator can triage today's health (US1) and clear specific failures
via the backlog drill + 017 repair (US2) without it. It is independently testable on
top of merged 017 run data and rounds out the read-model.

**Independent Test**: Seed a tenant with several reconciliation runs in different
terminal/non-terminal states; call the read-model run-history list as the tenant
admin; confirm runs are returned newest-first, paginated, each with status,
timestamps, trigger source, and per-class mismatch summary, scoped to that tenant.

**Acceptance Scenarios**:

1. **Given** a tenant with four runs (`completed`, `completed`, `failed`, `running`),
   **When** the operator lists run history, **Then** all four are returned
   newest-first with correct status, timestamps, trigger source, and mismatch summary.
2. **Given** runs across two tenants, **When** operator A lists run history, **Then**
   only tenant A's runs are visible (cross-tenant non-disclosure).
3. **Given** the deferred domains, **When** any run-history view that would include
   020/021 run-equivalents is requested, **Then** those domains report
   `status: not_available` rather than an empty list conflated with "ran and found
   nothing".

---

### Edge Cases

- **Source domain not yet available (020/021).** The read-model MUST report a deferred
  domain as an explicit `not_available` domain status, never as `0` healthy or an
  empty success list (which would falsely assert "checked, all clear"). `0`/empty is
  reserved for an available domain that genuinely has no rows.
- **Cross-tenant reference.** A request that names (via filter or path) a store or run
  belonging to another tenant MUST be non-disclosing — same response shape as
  "not found / not in scope", never a leak of existence or volume (§II / §XII).
- **No tenant context resolvable.** A request whose session does not resolve to a
  tenant MUST fail closed at the auth layer (§II RLS fail-closed); the read-model
  returns no rows rather than cross-tenant data.
- **Monetary fields in posting projections.** If a posting projection carries a sale
  amount, it MUST be passed through as an exact-decimal value with its currency code,
  never re-derived, re-rounded, or rewritten by the read-model (§III, §IX snapshot).
- **Underlying source schema evolves.** Because 025 is a projection (not a mirror),
  it re-reads current source state every request; a 015/017 row added/removed between
  two reads MUST simply reflect in the next read with no stale cached duplicate.
- **Large backlog / many runs.** List surfaces MUST be cursor-paginated and bounded;
  an unbounded full-table scan returned to the console is forbidden.
- **Bearer / machine credential presented.** A request authenticated with a
  `connectorBearer` or `dashboard_api` machine token (not a human cookie session)
  MUST be rejected — this is a human-operator surface only (§IV, mirrors 017/018).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a console-facing **sync-ops summary** read
  operation that returns, in a single response scoped to the active tenant, a
  per-domain operational health summary across the sync-ops domains (posting,
  reconciliation, connector-health, product-master).
- **FR-002**: The summary MUST report **posting health** derived from the 015
  `erpnext_posting_status` state: counts of healthy (`posted`, `pending`) vs
  dead-lettered (`permanently_rejected`) postings, computed-on-read (never a stored
  mirror).
- **FR-003**: The summary MUST report **reconciliation health** derived from the 017
  `erpnext_reconciliation_*` state: the latest run's status/outcome and a count of
  open (unresolved) mismatch results.
- **FR-004**: For each **not-yet-available source domain** (020 connector-health, 021
  product-master reconciliation), the summary MUST report an explicit
  `not_available` domain status (with a forward-compatible shape), distinct from an
  available domain reporting zero/empty.
- **FR-005**: The system MUST expose a console-facing **posting dead-letter backlog**
  read operation: a paginated, sortable, class-groupable list of 015
  `permanently_rejected` postings, each projected with mismatch class, originating
  reference, provenance (`sourceSystem` + `externalId`), structured rejection reason,
  and dead-letter timestamp.
- **FR-006**: The system MUST expose a console-facing **reconciliation run-history**
  read operation: a paginated, newest-first list of 017 runs, each projected with
  trigger source, status, start/finish timestamps, and a per-class mismatch summary.
- **FR-007**: All read operations MUST be authenticated with **cookieAuth and gated by
  the human-operator authorization guard** (`DashboardAuthGuard` + role gate), and
  MUST reject machine credentials (`connectorBearer`, `dashboard_api` bearer).
- **FR-008**: All read operations MUST execute under resolved **tenant context** so
  RLS scopes every underlying read; an unresolved tenant context MUST fail closed and
  return no rows.
- **FR-009**: All read operations MUST be **non-disclosing across tenants and stores**:
  a cross-tenant or out-of-scope reference returns the canonical "not found / not in
  scope" shape, never revealing existence or volume (§II / §XII canonical 404).
- **FR-010**: All response bodies MUST be **explicit wire-shape projections** (no raw
  DB entities, no internal columns, no credential or hash material), with stable
  `operationId`s, documented error responses, and the canonical error envelope
  (§III / §IV).
- **FR-011**: The read-model MUST be **read-only**: it MUST expose **no** create,
  update, delete, trigger, or repair affordance. Repair/run-trigger remain 017's
  `reconciliation.yaml` operations.
- **FR-012**: The read-model MUST be a **read-through projection** over existing
  015/017 state — it MUST NOT introduce a new persistent table, a new migration, or a
  materialized copy of source rows (no mirror, §IX).
- **FR-013**: Any **monetary value** surfaced in a posting projection MUST be passed
  through as exact-decimal with an explicit currency code, never re-derived,
  re-rounded, or rewritten (§III, §IX snapshot truth).
- **FR-014**: List surfaces MUST be **cursor-paginated, bounded, and deterministically
  ordered** so paging is gap-detectable and an unbounded scan is never returned.
- **FR-015**: The system MUST surface read-model usage and source-availability via the
  shared observability surface, reusing existing sync-ops metrics (e.g.
  reconciliation mismatch rate / POS sync lag named in §VII) rather than inventing a
  per-feature metrics file.
- **FR-016**: The console-facing contract MUST live in `packages/contracts/openapi/`
  as the OpenAPI 3.1 source of truth (a `[GATED]` artifact, authored under approval),
  under the `/api/v1/...` namespace, with conformance tests enforcing it.

### Key Entities *(read-model projections — no new persistence)*

- **SyncOpsSummary**: the aggregated per-tenant (store-filterable) health view. Holds
  one **DomainSummary** per sync-ops domain. Computed-on-read; not persisted.
- **DomainSummary**: per-domain operational state — `domain` (posting | reconciliation
  | connector_health | product_master), `status` (`ok` | `attention` |
  `not_available`), and domain-specific counts (e.g. posting: healthy/dead-lettered;
  reconciliation: latest-run status + open-mismatch count). Forward-compatible so a
  deferred domain renders as `not_available`.
- **PostingBacklogItem** (projection of 015 `erpnext_posting_status` where
  `status = 'permanently_rejected'`): mismatch class, originating sale/terminal-event
  reference, provenance (`sourceSystem` + `externalId`), structured rejection reason,
  dead-letter timestamp. Read-only; no repair affordance.
- **ReconciliationRunView** (projection of 017 `erpnext_reconciliation_run`): trigger
  source, status, start/finish timestamps, per-class mismatch summary. Read-only.
- **Pagination cursor**: opaque, deterministic cursor for the backlog and run-history
  lists; gap-detectable, bounded page size.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can retrieve a complete, correctly-scoped sync-ops health
  summary for their tenant in a **single** read request (no client-side stitching of
  multiple contracts).
- **SC-002**: 100% of cross-tenant and cross-store access attempts against every
  read operation return the canonical non-disclosing response (zero existence/volume
  leaks across the isolation sweep).
- **SC-003**: Posting-health counts and reconciliation run/mismatch counts returned by
  the read-model match the underlying 015/017 source state exactly for a seeded
  fixture (no drift, because the read-model recomputes on read and stores nothing).
- **SC-004**: Deferred domains (020/021) are reported as `not_available` in 100% of
  summary responses until their source specs land — never as a false `0`/empty
  "all clear".
- **SC-005**: Every list surface returns stable, gap-detectable, bounded pages; no
  read operation can return an unbounded full-table result.
- **SC-006**: Every read operation rejects machine credentials and unauthenticated
  requests, and accepts only an authenticated human cookie session with the required
  role (auth sweep passes).
- **SC-007**: The feature ships with **zero new migrations and zero new persistent
  tables** (verified: no `packages/db` schema or migration change), confirming the
  no-mirror posture.
- **SC-008**: Contract conformance tests pass for every `operationId` in the new
  console read-model contract (request/response schemas, error envelope, security
  scheme all enforced).

## Assumptions

- **Sibling-repo consumer.** The Retail Tower Console (separate repo) is the sole
  intended consumer; it integrates only through the DP2 OpenAPI contract, never the DB
  (§IV trust boundary).
- **Human-operator auth.** The console operator authenticates with an httpOnly cookie
  session (`DashboardAuthGuard`), the same scheme 017's `reconciliation.yaml` uses;
  machine schemes (`connectorBearer`, POS `clerkJwt`, `dashboard_api`) are out of
  scope and rejected.
- **Source availability.** Only 015 (posting status) and 017 (reconciliation
  runs/reports) are merged and readable in this repo today; 020 (connector health) and
  021 (product-master reconciliation) are future specs and are deferred via the
  `not_available` forward-compat shape (see Clarifications). 016 is on-hold.
- **No new authority, no mirror.** 025 reads existing operational state and projects
  it; it never becomes the source of truth, never copies rows into a new table, and
  never exposes a write. Repair/run-trigger remain 017 operations.
- **Read-through, recompute-on-read.** The read-model recomputes per request from
  current 015/017 state (the 009 compute-on-read + 017 READ-NOT-MIRROR posture); there
  is no cache that must be invalidated to stay correct.
- **No perf environment.** Performance assertions (latency/throughput) are
  report-only pending a dedicated perf environment, consistent with prior specs
  (005/008/009/010).
- **Single region.** Data-residency posture is single-region, inherited from the
  platform; the read-model surfaces no new PII class (only provenance + operational
  state already visible via 015/017).

## Clarifications

### Session 2026-06-07

- **Q: Two of the four named source domains (020 connector-health, 021 product-master
  reconciliation) do not exist as specs yet. How should v1 treat them — block, omit,
  or stub?**
  **A: Forward-compatible shape with partial v1 population.** Define the full sync-ops
  read-model shape across all four domains, but v1 populates only the buildable 015 +
  017 domains; 020/021 are present-but-deferred and report an explicit
  `not_available` domain status, to be wired when those specs land.
  **Rationale:** The console is a sibling repo that needs a stable contract now; a
  forward-compat stub gives it one without blocking on unwritten specs, and mirrors the
  repo's established deferral pattern (017's `STOCK-VIEW-CONTRACT` future-gate,
  `EMPTY_BIN_VIEW`). The independently-testable user stories are therefore the 015+017
  ones; 020/021 stay in Assumptions/Deferrals, not as fake "independently testable"
  stories.

- **Q: Should the read-model persist an aggregated projection (a new table refreshed
  by a worker) or compute on read?**
  **A: Compute-on-read, no new table, no migration.** The read-model is a
  read-through projection over existing 015/017 state.
  **Rationale:** A materialized projection would be both a drift risk and a `[GATED]`
  migration. Compute-on-read is the 009/017 established posture, keeps the no-mirror
  invariant (§IX) literally true, and makes the constitution story clean: the only
  gated surface is the OpenAPI contract.

- **Q: Which authentication scheme does the console read-model use?**
  **A: cookieAuth + `DashboardAuthGuard` (human-only), rejecting machine credentials.**
  **Rationale:** The console operator is a human; this mirrors 017's
  `reconciliation.yaml` operator contract exactly and keeps the machine boundary
  (`connectorBearer`, 018) cleanly separate. A `connectorBearer`/`dashboard_api`
  bearer is rejected.

- **Q: Does 025 expose any repair / run-trigger / write affordance?**
  **A: No — strictly read-only.** Repair and run-trigger remain 017's
  `reconciliation.yaml` write operations.
  **Rationale:** The spec context fixes 025 as a read-model with no new write surface
  and no new authority; mixing a write in would blur the 017↔025 carve and the
  no-mirror posture.

- **Q: How are monetary values (e.g. a posting's sale amount) handled in projections?**
  **A: Pass-through exact-decimal + currency code, never re-derived or rewritten.**
  **Rationale:** §III forbids float money and §IX makes the sale-line snapshot the
  historical truth; a read-model must surface the stored exact value verbatim, not
  recompute it.
