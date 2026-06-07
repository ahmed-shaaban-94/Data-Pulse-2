# Research — 020 Connector Health and Connection-Status API

Phase 0 output. Each unknown surfaced by the spec is resolved here with a decision, rationale, and rejected alternatives. The five spec clarifications (Q1–Q5) are restated as confirmed decisions; the two gated-surface clarifications (Q6 signal shape, Q7 contract placement) are resolved here so the planning chain carries the rationale to implementation.

## D1 — Transport model: active heartbeat vs passive last-seen (spec Q1)

**Decision**: Active heartbeat over the 018 `connectorBearer` scheme is the primary model; passive last-seen is an available byproduct but not the v1 mechanism. P1 (operator read) is built so it delivers value with zero heartbeats (`never_seen`), so the buildable MVP carries no cross-repo dependency.

**Rationale**: The 018 handoff names "last-seen / **lag / heartbeat**" — lag and connector-version/reachability cannot be derived from passively touching a timestamp on a 012 feed/ack call; they require a payload the connector actively sends. An explicit heartbeat op also gives the connector repo a clean, documented integration point.

**Alternatives rejected**:
- *Passive-only (touch `last_seen_at` inside the existing `connectorPullPostings`/`connectorAckOutcome` handlers)*: no new write surface, but cannot carry lag/version/reachability, and couples liveness to posting traffic (a connector idle on postings would look dead even if healthy). Rejected as insufficient for "health AND connection-status."
- *Both at once in v1*: more surface than needed; the passive touch can be added later without breaking the contract. Deferred.

## D2 — Storage: new `connector_health` table vs columns on `connector_registration` (spec Q2)

**Decision**: New `connector_health` table, one row per `connector_registration`, FK `connector_registration_id → connector_registration(id)`.

**Rationale**: 018's `0021` migration is closed and gated; reopening it to add high-churn telemetry columns mixes a stable identity table with churning observational state and forces a schema change on a shipped table. A separate table keeps identity (stable, audited) and liveness (churning, LWW) cleanly separated and lets the health row's lifecycle (delete-with-registration) be expressed by an FK.

**Alternatives rejected**:
- *Columns on `connector_registration`*: bloats a stable table with UPDATE churn on every heartbeat, increasing dead-tuple/vacuum pressure on the identity table and reopening a closed migration. Rejected.
- *Append-only heartbeat event log (one row per beat)*: full history, but unbounded growth for telemetry that only needs "latest," plus a heavier read (latest-per-registration). Rejected for v1; a future event log is a possible follow-up if per-beat history is ever needed.

## D3 — Concurrency posture: LWW vs optimistic version (spec Q3)

**Decision**: Last-write-wins via upsert (`INSERT … ON CONFLICT (connector_registration_id) DO UPDATE`). No `version` column.

**Rationale**: `last_seen_at` is monotonic; the correct convergence under concurrent beats is "latest wins." No invariant can be violated by two writers. §III permits LWW when justified; the justification is recorded in plan.md Complexity Tracking. A guard against a stale beat overwriting a newer one with an older `now()` is not needed because `last_seen_at` is the server clock at write time (each writer stamps its own `now()`, and the DB serializes the two upserts; the later commit's `now()` is ≥ the earlier).

**Alternatives rejected**:
- *Optimistic `version` + `If-Match`*: forces read-before-write + retry on a fire-and-forget heartbeat; contention and round-trips for zero correctness gain. Rejected.

## D4 — ERPNext reachability: DP2 probe vs connector self-report (spec Q4)

**Decision**: Connector self-report only, stored verbatim as a self-reported field. DP2 performs no outbound ERPNext HTTP.

**Rationale**: The entire 011→018 arc holds the invariant that DP2 never calls ERPNext directly — the connector poller (separate repo) is the sole ERPNext client. 020 measures connector→DP2 liveness; ERPNext→connector reachability is the connector's own observation, which it may include in its heartbeat for operator visibility. Storing it as self-reported (not authoritative) keeps §IX provenance honest.

**Alternatives rejected**:
- *DP2 actively probes ERPNext to confirm reachability*: violates the arc boundary (introduces an outbound ERPNext client into DP2), couples DP2 availability to ERPNext, and duplicates the connector's role. Rejected hard.

## D5 — Staleness threshold (spec Q5)

**Decision**: `healthy` iff `now() - last_seen_at <= 5 minutes`; `stale` if older; `never_seen` if `last_seen_at IS NULL`; `disabled` if the 018 registration's `disabled_at IS NOT NULL` (disabled takes precedence over `healthy`). Threshold is a documented server-side constant. Comparison documented as `<=` for healthy / `>` for stale (deterministic boundary).

**Rationale**: A 012-feed poller beats on the order of ≤1 minute; 5 minutes tolerates a few missed beats / a restart without flapping. Server-side constant keeps the verdict immune to client manipulation (§X). Tenant-tunable thresholds add config surface with no v1 demand — deferred.

**Alternatives rejected**:
- *Client-supplied or tenant-configured threshold in v1*: config surface and a manipulation vector (§X) with no demand. Deferred to a future spec.
- *Multiple graded thresholds (e.g. `degraded` band)*: more states than operators need for v1; `healthy`/`stale`/`never_seen`/`disabled` is sufficient. Deferrable additively later.

## D6 — Observability signal shape (spec Q6 — gated-adjacent; resolved here)

**Decision**: A single unlabeled counter `connector_heartbeat_total`, incremented per accepted heartbeat, registered in the shared `apps/api/src/observability/metrics/api.metrics.ts` 3-place register (declare + register + export accessor), mirroring 018's `connector_lifecycle_total`.

**Rationale**: A counter proves "beats are arriving" platform-wide at the lowest cardinality and matches the established arc precedent (010 `catalog_unpriced_issue_rate`, 015, 017, 018 `connector_lifecycle_total` all live unlabeled in the shared file). No per-instance/tenant/secret label (§VII cardinality + §XIV).

**Alternatives rejected**:
- *Per-connector currently-stale gauge*: needs per-instance evaluation → either high-cardinality labels (rejected) or a periodic sweep job (out of v1 scope). The per-instance verdict is already available to operators via the P1 read. Deferred to the future scheduled-sweep follow-up.
- *A per-feature metrics file*: violates the shared-`api.metrics.ts` precedent (010/015/017/018). Rejected.

## D7 — Contract placement: extend `connector-admin.yaml` vs new file (spec Q7 — gated; resolved here)

**Decision**: A new `[GATED]` contract `packages/contracts/openapi/erpnext-connector/connector-health.yaml`. Operations (proposed `operationId`s): `connectorReportHeartbeat` (POST, `connectorBearer`), `listConnectorHealth` (GET, `cookieAuth`), `getConnectorHealth` (GET `/{registrationId}`, `cookieAuth`). Canonical error envelope; documented `401`/`403`/`404`/`400`/`409`(N/A)/`429`(future) responses.

**Rationale**: 018's `connector-admin.yaml` is cookieAuth-only (session-only admin). The inbound heartbeat is `connectorBearer` (machine). Mixing two auth schemes in one file muddies the security model and the admin-vs-machine boundary. A new file follows the arc's one-concern-per-contract grain (012 `posting-feed.yaml` = connectorBearer feed; 017 `reconciliation.yaml` = cookieAuth operator; 018 `connector-admin.yaml` = cookieAuth lifecycle). Co-locating under `erpnext-connector/` keeps the connector-facing contracts together.

**Alternatives rejected**:
- *Extend `connector-admin.yaml`*: would put a `connectorBearer` op in a cookieAuth-only file. Rejected.
- *Split into two files (one per auth scheme)*: over-fragmentation for three closely related operations over one read-model. Rejected; one file with two security schemes (each op declares its own `security`) is cleaner.

## D8 — Auth reuse (no new primitive)

**Decision**: Heartbeat reuses the 018 `ConnectorAuthGuard` (full usability predicate; attaches `{ registrationId, tenantId, environment }`). Operator reads reuse the 018 **session-only admin guard** (rejects `principal.kind==="token"`, incl. `dashboard_api`) + `RolesGuard @Roles("owner","tenant_admin")` + `TenantContextGuard`. No new auth primitive is introduced.

**Rationale**: 018 already shipped exactly these guards for exactly this trust split. 020 is stricter-than-014/017 on the admin side by design (inherits 018's session-only rule). Reuse avoids drift and keeps the boundary auditable.

**Alternatives rejected**:
- *`DashboardAuthGuard` (allows `dashboard_api` bearer, the 014/017 pattern)*: 018 deliberately tightened this for the connector admin boundary; 020's operator read is part of that same boundary and must match. Rejected.

## D9 — Worker / scheduled sweep (deferral)

**Decision**: No worker in v1. The verdict is derived on read, so an instance becomes `stale` with no background job. A future scheduled stale-sweep (to proactively alert when a connector goes dark) is a named follow-up, rhyming with the 029 scheduled-reconciliation precedent.

**Rationale**: Read-derived verdict satisfies all v1 acceptance scenarios without async work (§V). Adding a sweep now would be speculative scope. Deferred and named.

## Open items carried to implementation (gate-time)

- Confirm the exact next free migration number at gate time (expected `0022`; depends on `main` state).
- Self-reported field bounds (version string max length, lag indicator type/range, reachability flag enum) finalized in data-model + DTO at implementation; research fixes the shape, not the exact lengths.
