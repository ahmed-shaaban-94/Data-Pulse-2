# Feature Specification: Connector Boundary Hardening v1

**Feature Branch**: `018-connector-boundary-hardening`

**Created**: 2026-06-06

**Status**: Draft

**Input**: Approved brainstorm design — [docs/superpowers/specs/2026-06-06-018-connector-boundary-hardening-design.md](../../docs/superpowers/specs/2026-06-06-018-connector-boundary-hardening-design.md). DP2-owned, connector-coordinated. Define the safe pilot boundary between Data-Pulse-2 and the ERPNext Connector — connector identity, credential lifecycle, scopes, registration, and the boundary contract — **not** live stock read and **not** fiscal.

## Context & Trigger

The ERPNext Connector is no longer theoretical: it is a real, deployed application with a working posting path that pulls sale work-items from Data-Pulse-2 and acknowledges outcomes (proven on the platform side). The operational risk has shifted from *"can it post?"* to *"can we safely operate a connector for a tenant pilot?"*

Today the boundary works but is too loose for pilot operations: a connector authenticates with a generic, unconstrained machine credential; there is no formal way to register a connector instance, no operator-safe way to issue / rotate / revoke its credential, no stable identity for *which* connector instance is calling, and no written boundary fixing which future capabilities belong to the platform versus the connector. This feature hardens that boundary so a tenant connector can be operated safely in a pilot.

## Clarifications

### Session 2026-06-06

- Q: Should one tenant be prevented from registering the same ERPNext site reference twice within the same environment? → A: Enforce uniqueness on (tenant, environment, ERPNext site reference) — duplicate registration is rejected with a clear error. (resolves Open Question 1)
- Q: What default expiry should an issued connector credential carry? → A: A bounded default of 90 days, operator-overridable at issue up to a maximum ceiling; a credential can never be minted without a bounded expiry.
- Q: Should connector credential/registration lifecycle actions emit an operational signal beyond the audit record? → A: Yes — an unlabeled counter for lifecycle actions (issue/rotate/revoke/disable) on the shared platform metrics surface; no per-instance/tenant/secret labels (cardinality + data-class discipline), mirroring the existing posting/reconciliation signal pattern.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register a connector instance and issue its first credential (Priority: P1) 🎯 MVP

A tenant administrator registers a connector instance for their tenant — naming it, recording which ERPNext site it targets, and which environment it serves (development, staging, pilot, or production) — then issues its first machine credential. The raw credential is shown exactly once, for the administrator to configure into the connector; it is never retrievable again.

**Why this priority**: Without a registration + a safely-issued credential, there is no controlled way to stand up a connector for a tenant at all. This is the minimum that makes the boundary operable, and it delivers value on its own (an operator can provision a connector and see it authenticate).

**Independent Test**: Register an instance, issue a credential, configure a connector (or simulate one) with the returned raw credential, and confirm it is accepted on the connector posting endpoints while the raw credential never appears again in any listing, response, or log.

**Acceptance Scenarios**:

1. **Given** a tenant administrator, **When** they register a connector instance with a display name, ERPNext site reference, and environment, **Then** a connector instance identity is created for their tenant and is listable, with no credential yet attached.
2. **Given** a registered connector instance, **When** the administrator issues a credential for it, **Then** a machine credential is created and its raw secret is returned exactly once in that response and never again.
3. **Given** an issued credential, **When** the connector presents it on the connector posting endpoints, **Then** it is accepted and the platform knows which connector instance is calling.
4. **Given** any later listing or retrieval of the instance or credential, **When** an administrator views it, **Then** they see identity and credential status (issued / expires / revoked times) but never the raw secret.

### User Story 2 - Rotate and revoke a connector credential safely (Priority: P2)

A tenant administrator rotates a connector's credential (because of a suspected leak, a scheduled rotation, or staff change), and can revoke a credential outright. Rotation replaces the secret atomically: the new secret is issued and the old one is invalidated in a single safe step, so there is never a window with two valid secrets and never a window with none if the new one fails to issue.

**Why this priority**: Pilot operations require the ability to respond to credential exposure and to retire credentials. It builds directly on US1 and is the second half of "operate safely."

**Independent Test**: Rotate a credential, confirm the old secret is immediately rejected and the new one accepted; force the issuance step to fail and confirm the old secret still works (no lockout); revoke a credential and confirm it is rejected while the instance identity remains intact.

**Acceptance Scenarios**:

1. **Given** a connector instance with one active credential, **When** the administrator rotates it, **Then** a new credential is issued for the same instance, the previous credential is invalidated immediately, and the new raw secret is returned exactly once.
2. **Given** a rotation where issuing the new credential fails, **When** the operation aborts, **Then** the previous credential remains active and usable (no lockout).
3. **Given** an active credential, **When** the administrator revokes it, **Then** it is rejected on the connector endpoints immediately while the connector instance identity stays registered.
4. **Given** a connector instance, **When** at any moment, **Then** it has at most one active (non-revoked) credential.

### User Story 3 - Disable a connector instance (Priority: P2)

A tenant administrator disables a connector instance entirely (decommissioning, a compromised connector, or pausing a pilot). Disabling the instance makes all of its credentials unusable at once, without deleting any history needed for audit.

**Why this priority**: Operators need a single switch to cut off a connector instance, distinct from revoking one credential. It complements US2 and is essential for incident response in a pilot.

**Independent Test**: Disable an instance and confirm its credential is rejected on the connector endpoints, that the instance and its credential records still exist for audit, and that no records were deleted.

**Acceptance Scenarios**:

1. **Given** a connector instance with an active credential, **When** the administrator disables the instance, **Then** the credential is rejected on the connector endpoints immediately.
2. **Given** a disabled instance, **When** an auditor reviews history, **Then** the instance and its credential records are still present (logical disable, not deletion).

### User Story 4 - Enforce that only connector credentials reach connector endpoints (Priority: P1)

The platform enforces that the connector posting endpoints accept **only** a properly-scoped, instance-linked, non-disabled connector credential — and reject everything else (human dashboard sessions, point-of-sale credentials, expired or revoked credentials, credentials with no instance link, or credentials whose instance was disabled) with a non-disclosing rejection that never reveals which condition failed.

**Why this priority**: This is the security backbone of the boundary. Even with registration and lifecycle in place, the boundary is not "hardened" unless the enforcement is provably tight. It is tested independently of the admin flows.

**Independent Test**: Present each disallowed credential type and condition (human session, point-of-sale credential, expired, revoked, unlinked, disabled-instance) and confirm each is rejected identically and non-disclosingly; present a valid connector credential and confirm acceptance with the calling instance identified.

**Acceptance Scenarios**:

1. **Given** a human dashboard session or a point-of-sale credential, **When** it is presented to a connector endpoint, **Then** it is rejected without disclosing why.
2. **Given** an expired, revoked, unlinked, or disabled-instance connector credential, **When** it is presented, **Then** it is rejected identically and non-disclosingly.
3. **Given** a valid, active, instance-linked connector credential, **When** it is presented, **Then** it is accepted and the calling connector instance is identified to the platform.
4. **Given** any connector request, **When** it is authorized, **Then** the tenant is taken from the credential's own identity, never from the request body or query.

### User Story 5 - A documented, agreed boundary of record (Priority: P3)

A tenant administrator, an auditor, and the connector team can read a single document that states the rules of the existing connector posting boundary (authentication, idempotency, replay behavior, error reporting, non-disclosure, and the rule that no customer-identifying or monetary data crosses in the credentialing surface) and an explicit table of which future capabilities belong to the platform versus the connector.

**Why this priority**: A shared boundary of record prevents scope drift and tells the connector team exactly what to build against. It is documentation, not runtime behavior, so it is lowest priority — but it is a required deliverable of "boundary hardening."

**Independent Test**: A reader unfamiliar with the system can, from the document alone, state how a connector authenticates, what happens on a replayed acknowledgement, and which spec owns the future live-stock-view capability versus the future health/status capability.

**Acceptance Scenarios**:

1. **Given** the boundary document, **When** a reader reviews it, **Then** the existing posting boundary's authentication, idempotency, replay, error, and non-disclosure rules are stated without redesigning that boundary.
2. **Given** the boundary document, **When** a reader reviews the ownership table, **Then** each future surface (health/status, live stock view, sales-posting command, tax/fiscal) is mapped to an owning future spec.

### Edge Cases

- **Legacy credentials with no instance link**: if connector credentials already exist that predate this feature, the platform MUST NOT silently re-home or normalize them. Their state is surfaced for an explicit owner decision before any tightening rule is enforced.
- **Rotation under concurrency**: two simultaneous rotation attempts on the same instance must not leave two active credentials; one wins, the other is rejected or no-ops, never producing a second active secret.
- **Issuing a credential for a disabled instance**: rejected — a disabled instance cannot receive a new usable credential.
- **Revoking an already-revoked credential / disabling an already-disabled instance**: idempotent no-op, not an error.
- **A credential whose instance belongs to a different tenant than the credential claims**: rejected non-disclosingly (cross-tenant probe).
- **A connector mid-request during rotation**: its next call with the old secret is rejected (the accepted v1 trade-off — the operator reconfigures the connector as part of rotating; a zero-downtime grace window is explicitly deferred).

## Requirements *(mandatory)*

### Functional Requirements

**Connector instance identity & registration**

- **FR-001**: The system MUST let a tenant administrator register a connector instance scoped to their tenant, recording a display name, an ERPNext site reference, and an environment (one of development, staging, pilot, production).
- **FR-002**: The system MUST reject a registration whose environment is not one of the allowed values, and whose display name is empty or blank.
- **FR-003**: The connector instance identity MUST be stable across credential rotation — rotating the secret MUST NOT change the instance identity that operators, audits, and future capabilities refer to.
- **FR-004**: The system MUST let a tenant administrator list their tenant's connector instances and view each instance's identity and status. Listings MUST NOT expose any secret.
- **FR-005**: A connector instance MUST belong to exactly one tenant and MUST be visible only within that tenant's scope.
- **FR-005b**: Every registration and credential-lifecycle operation (register / list / issue / rotate / revoke / disable) MUST require a privileged tenant role (owner or tenant administrator), not merely an authenticated dashboard principal. A non-privileged authenticated principal MUST be denied without disclosing the resource's existence (default-deny → 404, §II/§XII).
- **FR-005c**: The credential-lifecycle surface MUST be reachable **only by a human cookie session**, not by any machine bearer token — even an owner/tenant-admin `dashboard_api` bearer MUST be denied. Authorization is therefore TWO orthogonal checks: principal **kind** (human session only) AND **role** (owner/tenant_admin). The role check alone is insufficient because a `dashboard_api` machine bearer can belong to a privileged member; minting/rotating connector machine credentials from another machine bearer is the privilege path being closed. (Same default-deny → 404, non-disclosing.)
- **FR-005a**: The system MUST enforce that a tenant cannot register the same ERPNext site reference more than once within the same environment — registration MUST be unique on (tenant, environment, ERPNext site reference), and a duplicate registration MUST be rejected with a clear error (not silently accepted).

**Credential lifecycle**

- **FR-006**: The system MUST let a tenant administrator issue a machine credential for a registered, non-disabled connector instance.
- **FR-007**: The system MUST return the raw credential secret exactly once, at issue/rotation time, and MUST NOT store it in a recoverable form or expose it in any subsequent listing, retrieval, or log.
- **FR-008**: The system MUST let a tenant administrator rotate a connector instance's credential: a new credential is issued for the same instance and the previously active credential is invalidated, as one atomic operation.
- **FR-009**: If issuing the replacement credential during rotation fails, the system MUST leave the previous credential active (no lockout, no partial rotation).
- **FR-010**: The system MUST guarantee that a connector instance has at most one active (non-revoked) credential at any time.
- **FR-011**: The system MUST let a tenant administrator revoke a specific credential, after which it is rejected on connector endpoints while the connector instance identity remains registered.
- **FR-012**: Credentials MUST carry an expiry; an expired credential MUST be rejected on connector endpoints regardless of revocation state. A credential MUST NOT be issuable without a bounded expiry: the default expiry is 90 days, an administrator MAY override it at issue time, and the override MUST NOT exceed a maximum ceiling (so a credential can never be minted effectively-immortal).

**Instance disable**

- **FR-013**: The system MUST let a tenant administrator disable a connector instance, after which all of that instance's credentials are rejected on connector endpoints.
- **FR-014**: Disabling a connector instance MUST be logical — it MUST NOT delete the instance or its credential records, which are retained for audit.

**Boundary enforcement**

- **FR-015**: The connector posting endpoints MUST accept a credential only if it is an active, non-expired, non-revoked machine connector credential that is linked to a connector instance, the instance belongs to the credential's tenant, and the instance is not disabled.
- **FR-016**: The connector posting endpoints MUST reject every other credential type and condition — human dashboard sessions, point-of-sale credentials, expired/revoked/unlinked credentials, and disabled-instance credentials — with a single non-disclosing rejection that does not reveal which condition failed.
- **FR-017**: On an accepted connector request, the system MUST identify which connector instance is calling so that handling and audit can record it.
- **FR-018**: The tenant for any connector request MUST be derived from the credential's own identity, never from the request body or query.
- **FR-019**: Tightening the enforcement MUST NOT change authentication behavior for human dashboard or point-of-sale credentials.

**Audit & non-disclosure**

- **FR-020**: The system MUST record auditable evidence for every lifecycle action — instance registered, instance disabled, credential issued, credential rotated, credential revoked — capturing the acting administrator, the instance, and the credential, but never the raw secret.
- **FR-021**: The system MUST NOT log raw credential secrets anywhere; the only place a raw secret appears is the one-time issue/rotation response.
- **FR-022**: The connector credentialing surface MUST NOT carry customer-identifying (PII) or monetary data.
- **FR-022a**: The system MUST emit an operational signal (an unlabeled counter) for connector lifecycle actions — credential issued / rotated / revoked and instance registered / disabled — on the platform's shared metrics surface, for operational visibility. The signal MUST NOT carry per-instance, per-tenant, or secret-bearing labels (cardinality and data-class discipline). This is in addition to, not a replacement for, the audit evidence in FR-020.

**Boundary of record**

- **FR-023**: The system MUST produce a boundary document stating the existing connector posting boundary's authentication, idempotency, replay, error, and non-disclosure rules, without redesigning that boundary.
- **FR-024**: The boundary document MUST include a surface-ownership table mapping each future capability — connector health/status, live ERPNext stock view, sales-posting command, and tax/fiscal — to its owning future spec.

**Scope guards (negative requirements)**

- **FR-025**: This feature MUST NOT implement the live ERPNext stock read, scheduled reconciliation, or any tax/fiscal behavior.
- **FR-026**: This feature MUST NOT change point-of-sale or administrative-console behavior, and MUST NOT cause the platform to make outbound calls to ERPNext.
- **FR-027**: This feature MUST NOT redesign the existing, working connector posting boundary; it documents and hardens access to it.

### Key Entities *(include if feature involves data)*

- **Connector Instance (registration)**: the stable, operator-facing identity of one connector deployment for one tenant. Attributes: tenant, display name, ERPNext site reference, environment (dev/staging/pilot/prod), creation provenance, and a logical disabled state. Holds no secret. Survives credential rotation. The thing future capabilities (health/status, stock view, posting command) authorize against.
- **Connector Credential**: a machine secret a connector instance presents to authenticate. Attributes: a non-recoverable stored form of the secret, an issue time, an expiry, a revoked state, and a link to its connector instance. At most one active credential per instance. The raw secret exists only momentarily at issue/rotation.
- **Lifecycle Audit Evidence**: a durable record of each registration/credential action (register, disable, issue, rotate, revoke) with actor and target references — never the raw secret. (Reuses the platform's existing audit facility.)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A tenant administrator can register a connector instance and issue its first usable credential, end to end, in a single sitting.
- **SC-002**: 100% of issued credentials reveal their raw secret exactly once; no raw secret is retrievable afterward through any listing, retrieval, or log.
- **SC-003**: After a rotation, the old credential is rejected on the very next connector request and the new credential is accepted — with no interval in which two credentials are simultaneously valid.
- **SC-004**: A connector instance never has more than one active credential, verified across concurrent rotation attempts.
- **SC-005**: 100% of disallowed access attempts on the connector endpoints (human session, point-of-sale credential, expired, revoked, unlinked, disabled-instance, cross-tenant) are rejected, and rejections are indistinguishable from one another (non-disclosing).
- **SC-006**: Disabling a connector instance blocks all its credentials on the next request while deleting no records.
- **SC-007**: Every lifecycle action produces audit evidence, and no raw secret appears in any audit record or log.
- **SC-008**: A reader can determine, from the boundary document alone, how a connector authenticates, what a replayed acknowledgement does, and which future spec owns the live stock view versus the health/status capability.
- **SC-009**: Registering a connector instance for an (environment, ERPNext site reference) pair that the tenant has already registered in that environment is rejected with a clear error, 100% of the time.
- **SC-010**: Every issued credential has a bounded expiry (default 90 days, never exceeding the maximum ceiling), verified across default and operator-overridden issuance.
- **SC-011**: Every lifecycle action increments the operational lifecycle counter, and the counter exposes no per-instance, per-tenant, or secret-bearing label.

## Assumptions

- **Auth reuse**: The platform's existing opaque, revocable machine-credential mechanism and tenant-scoped data isolation are reused; this feature adds connector-instance identity and lifecycle on top, not a new authentication primitive.
- **Operator audience**: Credential and registration management is performed by an authenticated human tenant administrator through the platform's administrative authentication, not by the connector itself or a point-of-sale device.
- **Controlled connector**: The connector is a server the operator controls and reconfigures as part of rotation, so an immediate-cutover rotation (no zero-downtime grace window) is acceptable for v1. A grace window, if ever needed, is a separate later effort.
- **Existing posting boundary stands**: The current connector posting feed/acknowledgement boundary is correct and working; this feature documents and hardens access to it rather than changing it.
- **Connector-side counterpart**: A connector-repository counterpart effort consumes this boundary after it is defined here; it is authored after, never before, this spec.

## Dependencies

- The shipped connector posting boundary (the feed/acknowledgement surface the connector already uses).
- The platform's existing machine-credential store, administrative authentication, tenant isolation, and audit facility.

## Out of Scope (handed to named future specs)

- **019 — live ERPNext stock-view contract** (this is the capability previously reserved as the deferred stock-view handle in the reconciliation spec; **019 is that contract** — one identity).
- **020 — connector health/status capability** (last-seen / lag / heartbeat; references the connector instance identity defined here).
- **023 — sales-posting command contract** (only if a gap over the existing posting boundary is proven; reuses this identity boundary).
- **016 — tax/fiscal** (on hold).
- **029 — scheduled reconciliation**.
- **Connector-repository counterpart spec** (consumes this boundary).

## Open Questions

**Resolved in clarification (Session 2026-06-06):**

1. ~~**Per-environment site uniqueness**~~ — **RESOLVED: enforced** on (tenant, environment, ERPNext site reference); duplicate registration rejected with a clear error (FR-005a, SC-009).
2. ~~**Credential default expiry**~~ — **RESOLVED: 90-day default**, operator-overridable up to a maximum ceiling, never unbounded (FR-012, SC-010).
3. ~~**Lifecycle observability**~~ — **RESOLVED: an unlabeled lifecycle counter** on the shared metrics surface, in addition to audit (FR-022a, SC-011).

**Still carried to planning (genuinely plan-time / preflight-dependent):**

4. **Administrative surface form**: whether credential/registration management is exposed as platform administrative endpoints or an operator tool is a planning-time decision; if it introduces a new external contract surface, it requires explicit gated approval before authoring.
5. **Legacy credential handling**: the exact handling of any pre-existing connector credentials (backfill a legacy instance vs. document and defer the tightening rule) depends on a preflight inspection of existing data; stray or legacy records are a stop-and-raise for an owner decision, never an automatic normalization.
