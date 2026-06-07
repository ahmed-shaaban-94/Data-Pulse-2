# Feature Specification: Connector Health and Connection-Status API

**Feature Branch**: `020-connector-health-and-connection-status-api`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "Connector health and connection-status API"

## Overview

The ERPNext integration arc (011→018) shipped a DP2-owned connector boundary: spec 018 established the **connector instance identity** (`connector_registration`), an opaque-bearer credential lifecycle, and a tightened `ConnectorAuthGuard` that attaches `{ registrationId, tenantId, environment }` to every authenticated connector call. Spec 018 explicitly named **020 — connector health/status capability (last-seen / lag / heartbeat; references the connector instance identity defined here)** as a future arc handoff.

This feature delivers that capability. A registered connector instance can report its liveness (a heartbeat over the existing machine `connectorBearer` scheme), and a tenant administrator can read the current connection status of each of their connector instances (over the human `cookieAuth` session, the 018 session-only admin pattern). DP2 derives the liveness **verdict** from its own server clock — it never trusts a connector self-reporting "I am healthy." The boundary of the whole arc holds: **DP2 makes no outbound ERPNext HTTP**; any ERPNext-reachability detail is a self-reported field DP2 stores, never a probe DP2 performs.

This is a heartbeat/status surface only: **no money, no PII** (BUSINESS-class observational data).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator reads connector connection status (Priority: P1) 🎯 MVP

A tenant administrator opens the connector administration surface and views, for each of their tenant's registered connector instances, its current connection status: whether it has ever been seen, when it was last seen, and a derived liveness verdict (e.g. `healthy` / `stale` / `never_seen`) computed against the server clock. This is the unambiguously DP2-owned, fully buildable core: even with zero heartbeats ever received, the operator can list instances and see `never_seen`.

**Why this priority**: This is the operator-facing value of the feature and is buildable entirely inside DP2 with no dependency on the connector repo or a live ERPNext. It is the safe MVP — it reads the 018 registration identity and a (possibly empty) health read-model and returns a status projection. The capability 018 promised is satisfied by P1 alone.

**Independent Test**: Seed a tenant with two connector registrations (one with a recorded last-seen within the healthy window, one with none). Call the operator status-read endpoint with a tenant_admin cookie session. Assert the response lists both instances with the correct derived verdict (`healthy` and `never_seen`), exposes last-seen and lag-derived fields, and exposes **no secret** and **no raw token**. Assert a cross-tenant registration is invisible (safe 404 / absent from the list), a non-admin session is denied, and a `dashboard_api` bearer is denied (018 session-only rule).

**Acceptance Scenarios**:

1. **Given** a tenant_admin cookie session and two registered connector instances, **When** the administrator lists connection status, **Then** each instance returns its identity (id, display name, environment, ERPNext site reference) plus `last_seen_at`, a derived `liveness` verdict, and seconds-since-last-seen, with no secret material.
2. **Given** a connector instance that has never sent a heartbeat, **When** the administrator reads its status, **Then** the verdict is `never_seen` and `last_seen_at` is null.
3. **Given** a connector instance whose last heartbeat is older than the staleness threshold, **When** the administrator reads its status, **Then** the verdict is `stale`.
4. **Given** a connector instance that has been logically disabled (018 `disabled_at` set), **When** the administrator reads its status, **Then** the status reflects the disabled state and is not reported as `healthy`.
5. **Given** a `dashboard_api` bearer token (even one whose principal holds an admin role), **When** it is presented to the status-read endpoint, **Then** the request is denied (session-only admin guard, 018 FR-005c precedent).
6. **Given** an administrator of tenant A, **When** they request the status of a connector instance owned by tenant B, **Then** the response is the canonical "does not exist" shape (safe 404), never a disclosure.

---

### User Story 2 - Connector reports liveness via heartbeat (Priority: P2)

A running connector instance periodically POSTs a heartbeat to DP2 over its machine `connectorBearer` credential. DP2 resolves the instance identity from the 018 guard-attached context (never from the request body), records a server-clock `last_seen_at` and a small, bounded set of self-reported observational fields (e.g. connector software version, backlog/lag indicator, and a self-reported ERPNext-reachability flag), and acknowledges. This makes the P1 operator read transition from `never_seen` to `healthy`/`stale` over time.

**Why this priority**: It is the data source that makes P1 dynamic, but P1 delivers value without it (showing `never_seen` is itself operationally meaningful). Building P2 requires the inbound `connectorBearer` write path and a `[GATED]` contract operation, so it carries more surface than P1 and is sequenced second. The connector that actually calls it lives in a separate repo; the cross-system live leg is therefore a deferred validation (consistent with the arc's 🔶 cross-system deferral).

**Independent Test**: With a connector credential whose 018 guard resolves to a known registration, POST a heartbeat. Assert a `connector_health` row is created/updated with a server-clock `last_seen_at`, that body-supplied identity fields (`tenant_id`, `registration_id`) are ignored in favor of the guard-attached context, that the self-reported fields are stored within bounds, and that the operator read (P1) now reports `healthy`. Assert a heartbeat presenting a credential whose registration is disabled or whose token is revoked/expired is denied by the 018 usability predicate (non-disclosing 401).

**Acceptance Scenarios**:

1. **Given** a usable connector credential, **When** the connector POSTs a heartbeat, **Then** DP2 records `last_seen_at = now()` (server clock) on the health row for the guard-resolved registration and returns an acknowledgement.
2. **Given** a heartbeat body that includes `tenant_id` or `registration_id`, **When** it is processed, **Then** those body fields are ignored and the identity is taken from the 018 guard-attached context (mass-assignment ban, §XII).
3. **Given** a heartbeat carrying self-reported fields (connector version, backlog indicator, ERPNext-reachability flag), **When** it is processed, **Then** those fields are stored verbatim as **self-reported** values and never trigger any outbound ERPNext call by DP2.
4. **Given** a credential whose linked registration is disabled (018 predicate clause 7), **When** a heartbeat is presented, **Then** the request is rejected with the non-disclosing 401 (no new health row, no last-seen update).
5. **Given** two heartbeats arriving close together for the same registration, **When** both are processed, **Then** the health row converges to the latest `last_seen_at` (last-write-wins is correct for monotonic observational data; §III justification recorded).

---

### User Story 3 - Operator inspects a single connector's health detail (Priority: P3)

A tenant administrator selects one connector instance and views its full health detail: identity, last-seen, derived verdict, the most recent self-reported observational fields (version, backlog indicator, ERPNext-reachability self-report), and the time those were reported. This is the drill-down companion to the P1 list.

**Why this priority**: Convenience/drill-down over the same read-model P1 and P2 establish. It adds no new write path and no new data, only a single-resource read projection, so it is the lowest priority and the simplest increment.

**Independent Test**: Seed a registration with a heartbeat carrying self-reported fields. Call the single-instance health-detail endpoint with a tenant_admin session. Assert the detail projection returns identity + derived verdict + self-reported fields, with no secret. Assert cross-tenant returns safe 404 and a non-admin / `dashboard_api` bearer is denied.

**Acceptance Scenarios**:

1. **Given** a tenant_admin session and a registration with a recorded heartbeat, **When** the administrator reads the single-instance health detail, **Then** the response returns identity, derived verdict, last-seen, and the most recent self-reported fields, with no secret.
2. **Given** a registration id that belongs to another tenant, **When** the administrator requests its detail, **Then** the response is the canonical safe 404.

---

### Edge Cases

- **Heartbeat for a never-registered or deleted instance**: the 018 usability predicate already rejects credentials not linked to a usable registration; such a heartbeat is denied with a non-disclosing 401 and creates no health row.
- **Clock skew on self-reported time**: the connector may report its own clock value; DP2 stores it as `source_clock_at`-style provenance but derives liveness only from the server-clock `last_seen_at` (§X — security/liveness clocks are server clocks).
- **Heartbeat after disable**: a disabled registration's credentials fail the 018 predicate; no last-seen update occurs, and the operator read shows the disabled state, never `healthy`.
- **Boundary of the staleness threshold**: an instance last seen exactly at the threshold boundary resolves deterministically (the threshold comparison is documented and strict), avoiding flapping.
- **Oversized or unbounded self-reported payload**: the heartbeat body is strictly validated; unknown keys are rejected and the self-reported fields are length/range-bounded (§XII strict validation; cardinality discipline).
- **Concurrent heartbeats**: converge to the latest `last_seen_at` without error (LWW).
- **No connector ever registered**: the operator list returns an empty collection, not an error.

## Requirements *(mandatory)*

### Functional Requirements

#### Operator read (US1 / US3)

- **FR-001**: The system MUST let a tenant administrator list the connection status of every connector instance registered to their tenant, returning for each: instance identity (id, display name, environment, ERPNext site reference), `last_seen_at` (nullable), a derived liveness verdict, and the elapsed time since last seen.
- **FR-002**: The system MUST derive the liveness verdict from the server clock by comparing `last_seen_at` against a documented staleness threshold, producing at minimum `healthy`, `stale`, and `never_seen`; a logically disabled registration MUST surface as a `disabled` state and MUST NOT be reported as `healthy`.
- **FR-003**: The system MUST let a tenant administrator read the single-instance health detail of one connector instance owned by their tenant, returning identity, derived verdict, last-seen, and the most recent self-reported observational fields.
- **FR-004**: Operator read responses MUST be explicit wire projections (no raw DB entities, §IV) and MUST NOT expose any secret, token, or token hash.
- **FR-005**: The operator read surface MUST be authorized by the 018 session-only admin pattern: a human owner/tenant_admin cookie session only. It MUST reject token principals, including `dashboard_api` bearers, even when the principal holds an admin role (018 FR-005c). Endpoints with no explicit authorization annotation MUST fail closed (§XII default-deny).
- **FR-006**: Cross-tenant reads MUST return the canonical "does not exist" response shape (safe 404), never disclosing existence in another tenant (§II / §XII).

#### Connector heartbeat (US2)

- **FR-007**: The system MUST accept a liveness heartbeat from a connector instance authenticated by the 018 machine `connectorBearer` scheme, subject to the full 018 usability predicate (token exists/unexpired/unrevoked, scope=connector, linked-and-tenant-matched registration, registration not disabled). A heartbeat failing the predicate MUST be rejected with the non-disclosing 401.
- **FR-008**: The system MUST resolve the heartbeat's connector identity and tenant from the 018 guard-attached context (`{ registrationId, tenantId, environment }`), NEVER from the request body. Body-supplied `tenant_id`, `registration_id`, `last_seen_at`, or any identity field MUST be ignored or rejected (mass-assignment ban, §XII).
- **FR-009**: The system MUST record `last_seen_at` from the **server clock** (`now()`), not from any client/connector-reported time (§X).
- **FR-010**: The system MUST persist a small, bounded set of self-reported observational fields from the heartbeat — at minimum a connector software version string, a backlog/lag indicator, and a self-reported ERPNext-reachability flag — stored verbatim as **self-reported** values. These MUST be strictly validated (unknown keys rejected; length/range bounded).
- **FR-011**: The system MUST NOT perform any outbound HTTP to ERPNext as part of heartbeat processing or status derivation. Any ERPNext-reachability information is the connector's self-report only (arc boundary).
- **FR-012**: Heartbeat processing MUST be idempotent and convergent: repeated or concurrent heartbeats for the same registration converge to the latest `last_seen_at` (last-write-wins; §III justification recorded — monotonic observational data, no business invariant requires optimistic concurrency).
- **FR-013**: The heartbeat MAY preserve the connector-reported clock value as provenance (a `source_clock_at`-style field) but MUST NOT use it for the liveness verdict (§X).

#### Data, isolation, lifecycle

- **FR-014**: The system MUST store per-connector health state in a tenant-scoped read-model keyed to the 018 `connector_registration(id)`, with `tenant_id` NOT NULL and a fail-closed RLS policy (empty-GUC CASE guard) mirroring `0019`/`0020`/`0021`. The runtime DB role MUST NOT bypass RLS.
- **FR-015**: The health read-model MUST hold **no money, no PII, and no secret** (BUSINESS-class, §XIV). It MUST NOT duplicate or mirror the 018 credential/secret material; identity is referenced by FK to `connector_registration`, not copied.
- **FR-016**: When a connector registration is disabled (018), its health state MUST remain readable for operational visibility (the operator can see "last seen before it was disabled") but MUST NOT report `healthy`.
- **FR-017**: The system MUST emit auditable evidence appropriate to the surface; at minimum, operator reads of connector status are subject to the platform's standard request observability. Heartbeat ingestion is high-frequency machine traffic and SHOULD NOT write an audit row per beat (cardinality discipline); if any audit is recorded it MUST follow the canonical event shape and carry no secret.

#### Observability (§VII)

- **FR-018**: The system MUST expose connector liveness as an operational signal on the platform's shared metrics surface (`apps/api/src/observability/metrics/api.metrics.ts`). The signal MUST follow the 018/010/015/017 precedent: registered in the shared file's 3-place register, not a per-feature metrics file, and MUST NOT carry per-instance, per-tenant, or secret-bearing labels (cardinality + §XIV). The chosen signal shape is resolved in research.md (see Clarifications Q6): a heartbeat-received counter (`connector_heartbeat_total`).
- **FR-019**: The heartbeat path and the operator read path MUST carry `request_id` / `correlation_id` and structured logs per §VII, redacted of any secret at the logger boundary.

#### Contract (§IV) — described in prose; the gated YAML is NOT created by this spec

- **FR-020**: A `[GATED]` OpenAPI 3.1 contract surface MUST define the operator read operations (list + single-detail) under `cookieAuth` and the connector heartbeat operation under `connectorBearer`, with stable `operationId`s, the canonical error envelope, and documented error responses. The extend-vs-new-contract decision is resolved in research.md (see Clarifications Q7): a **new** contract file `packages/contracts/openapi/erpnext-connector/connector-health.yaml`, because the inbound heartbeat uses `connectorBearer` and does not belong in 018's cookieAuth-only `connector-admin.yaml`.

### Key Entities *(include if feature involves data)*

- **Connector Health State (`connector_health`)**: the current liveness read-model for one connector instance. One row per `connector_registration`. Attributes: FK to `connector_registration(id)`, `tenant_id` (NOT NULL, RLS axis), `last_seen_at` (nullable timestamptz, server clock), and the most recent self-reported observational fields (connector version, backlog/lag indicator, ERPNext-reachability flag, optional `source_clock_at` provenance), plus the time those self-reported fields were last updated. Holds no secret, no PII, no money. Tenant-scoped, fail-closed RLS. Concurrency: last-write-wins (observational, monotonic).
- **Liveness Verdict (derived, not stored)**: `healthy` / `stale` / `never_seen` / `disabled`, computed at read time from `last_seen_at`, the server clock, the staleness threshold, and the 018 registration's `disabled_at`. Never persisted (it is a function of current time).
- **Connector Instance (`connector_registration`, from 018 — referenced, not redefined)**: the stable operator-facing identity. 020 references it by FK and reads its `disabled_at`; 020 does not modify it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A tenant administrator can list the connection status of all their connector instances in a single authenticated read, with each instance showing identity, last-seen, and a derived liveness verdict, and zero secret material in the response.
- **SC-002**: An instance that has never sent a heartbeat is reported as `never_seen`; an instance whose last heartbeat predates the staleness threshold is reported as `stale`; an instance seen within the threshold is reported as `healthy` — verifiable by seeding three registrations with controlled `last_seen_at` values.
- **SC-003**: A connector heartbeat presented with a usable 018 credential updates the corresponding `last_seen_at` to the server clock and is reflected in the operator read on the next call; a heartbeat with a disabled/revoked/expired credential is rejected with the non-disclosing 401 and changes no state.
- **SC-004**: Every operator read and heartbeat route denies a cross-tenant access attempt with the canonical safe 404, denies a non-admin session, and denies a `dashboard_api` bearer on the operator surface — verified by sweep tests.
- **SC-005**: No DP2 code path triggered by heartbeat processing or status derivation makes an outbound HTTP request to ERPNext — verifiable by inspection and by the absence of any ERPNext client in the feature's dependency surface.
- **SC-006**: The health read-model passes the RLS bypass probe (wrong `app.current_tenant` → zero rows) and the cross-tenant isolation sweep (another tenant's registration invisible).
- **SC-007**: Application-code line coverage for the feature is ≥80%, including the heartbeat idempotency/convergence test and the liveness-threshold boundary test.

## Assumptions

- 018 is shipped on `main`: `connector_registration`, the `connectorBearer` scheme, the tightened `ConnectorAuthGuard` (attaching `{ registrationId, tenantId, environment }`), and the session-only admin guard + `RolesGuard` are all available for reuse. 020 builds on them and does not re-invent any auth primitive.
- The connector that calls the heartbeat endpoint lives in the separate `Retail-Tower-ERP-Next-Connector` repo. The cross-system live leg (a real connector actually beating to a real DP2) is a deferred validation, not part of this DP2-side spec, consistent with the arc's 🔶 cross-system deferral.
- The staleness threshold is a documented server-side constant/config, not client-supplied. A default is chosen in this spec's clarifications; tenant-tunable thresholds are out of scope for v1.
- No scheduled stale-sweep worker is required for v1: the verdict is derived on read, so an instance becomes `stale` without any background job. A future scheduled sweep (to proactively alert) is a named follow-up, rhyming with the 029 scheduled-reconciliation precedent — out of scope here.
- The health read-model is a **new** table; 018's `0021` migration is closed and health has a different churn/lifecycle profile, so health state is not added as columns on `connector_registration`.
- Single-region data residency posture (§XIV) — same as the rest of the arc; heartbeat/status is BUSINESS-class observational data.
- No money and no PII anywhere in this feature.

## Clarifications

### Session 2026-06-07

- **Q1: Active heartbeat (new inbound `connectorBearer` write op) vs passive last-seen (touch a timestamp on any existing 012 feed/ack call)?**
  **A: Active heartbeat is the model, with passive last-seen as an available byproduct.** The feature name is "health AND connection-status," which implies a richer self-reported payload (version, lag, reachability) than a bare timestamp can carry. P1 (operator read) is structured to deliver value even before any heartbeat exists (`never_seen`), so the MVP does not depend on the inbound write path; P2 adds the active heartbeat. *Rationale*: matches the explicit 018 handoff wording ("last-seen / lag / heartbeat"), keeps the buildable MVP free of cross-repo dependency, and gives operators meaningful detail beyond liveness.

- **Q2: New `connector_health` table vs extending 018's `connector_registration`?**
  **A: A new `connector_health` table, one row per registration, FK to `connector_registration(id)`.** *Rationale*: 018's `0021` is a closed, gated migration; health state is high-churn observational data with a different lifecycle than the stable identity; keeping it separate avoids reopening a closed migration and avoids mixing identity (stable) with liveness (churning).

- **Q3: Concurrency posture for the heartbeat write — optimistic version column or last-write-wins?**
  **A: Last-write-wins, explicitly justified.** *Rationale*: `last_seen_at` and self-reported fields are monotonic observational data with no business invariant that two concurrent writers could corrupt; §III permits LWW when justified, and an optimistic `version` column would add churn and contention for no correctness benefit. This justification is recorded per §III and the "Concurrency & Optimistic Locking" constitution section.

- **Q4: Does DP2 verify the connector's ERPNext reachability?**
  **A: No. ERPNext-reachability is a connector self-report stored verbatim; DP2 performs no outbound ERPNext HTTP.** *Rationale*: the entire 011→018 arc holds the boundary that DP2 never calls ERPNext directly (the connector poller is the only ERPNext client, in a separate repo); 020 tracks connector→DP2 liveness, not DP2→ERPNext.

- **Q5: Staleness threshold default for the derived verdict.**
  **A: A connector is `healthy` if `last_seen_at` is within the last 5 minutes of the server clock, `stale` if older, `never_seen` if null, `disabled` if the registration is disabled.** *Rationale*: a connector poller on the 012 feed is expected to beat on the order of a minute or less; a 5-minute window tolerates a few missed beats / restarts without flapping, and the threshold is a documented server-side constant (tenant-tunable thresholds deferred to a future spec). The boundary comparison is strict to avoid flapping.

- **Q6: Observability signal shape (FR-018) — counter, gauge, or both?**
  **A: A single unlabeled heartbeat-received counter (`connector_heartbeat_total`).** *Rationale*: a counter is the cheapest, lowest-cardinality signal that proves "beats are arriving" platform-wide and matches the 018 `connector_lifecycle_total` precedent (unlabeled, registered in the shared 3-place register). A currently-stale **gauge** would need per-instance evaluation (cardinality pressure or a sweep job) and is deferred to the future scheduled-sweep follow-up; per-instance verdict is already available to operators via the P1 read.

- **Q7: Extend 018's `connector-admin.yaml` or author a new contract file (FR-020)?**
  **A: Author a new `[GATED]` contract `packages/contracts/openapi/erpnext-connector/connector-health.yaml`.** *Rationale*: the inbound heartbeat is authenticated by the machine `connectorBearer` scheme, which does not belong in 018's cookieAuth-only admin contract; mixing the two auth schemes in one file would muddy the security model. A new file keeps `operationId`s and security cleanly separated and follows the arc's one-concern-per-contract grain (012 `posting-feed.yaml`, 017 `reconciliation.yaml`, 018 `connector-admin.yaml`).

No `[NEEDS CLARIFICATION]` markers remain. All seven were auto-resolved with best-judgment defaults grounded in the 018 handoff, the arc boundary, and the constitution. Two (Q6 signal shape, Q7 contract placement) touch `[GATED]` surfaces and are restated as decisions in research.md so the planning phase carries the rationale; neither is left for the human, but both are flagged as gated-surface design that the implementer must honor when the gate is approved.
