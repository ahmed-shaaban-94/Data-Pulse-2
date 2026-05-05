# Feature Specification: Foundation — Auth, Tenants, Stores, Roles

**Feature ID**: 001
**Short name**: foundation-auth-tenant-store
**Status**: Draft
**Created**: 2026-05-01
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.0

---

## 1. Background & Why

Data-Pulse-2 is the multi-tenant SaaS rebuild for Data Pulse. Before any product
catalog, inventory, orders, POS sync, or analytics work can begin, the system needs
a secure, well-defined foundation for **identity** (who is acting), **tenancy**
(whose data they are acting on), and **scope** (which store within the tenant they
are acting on).

Every business-domain feature in this repo (and every API consumed by the separate
POS application) will depend on this foundation. A weak foundation makes tenant
data leakage, privilege escalation, and cross-tenant store misuse practically
inevitable. This spec exists to make the foundation strong, explicit, and reusable
before downstream work attaches to it.

This is **specification-only**. No application code is produced in this step.

---

## 2. Goals

- Define the minimum data and behavior needed for users to authenticate, be scoped
  to a tenant, and act on a specific store within that tenant.
- Make tenant isolation a backend-enforced property, not a frontend convention.
- Define a role/permission model that the dashboard and (later) POS APIs can both
  reuse.
- Define an active **tenant + store context** that is server-resolved on every
  authenticated request.
- Leave a stable seam where future POS devices and sync sessions can attach to
  the tenant + store + user model without redesign.

## 3. Non-Goals

- POS application UI, offline behavior, or local storage (separate repository).
- Product catalog, inventory, orders, payments, or any business-domain entity
  beyond what's needed to model "store" as an organizational unit.
- POS sync APIs themselves (only the foundation they will depend on).
- Reports, analytics pipelines, dbt models.
- Billing, subscriptions, plan limits, metering.
- Any UI implementation.
- Any code at all in this step.

---

## 4. Actors / Personas

| Actor | Description | Typical Capability |
|---|---|---|
| **Platform Admin** | Operator of the SaaS (us). Can manage tenants and impersonate for support, with audit. | Cross-tenant; restricted, audited. |
| **Tenant Owner** | Person who owns/created a tenant. Full authority within that tenant. | Manage tenant settings, users, stores, roles. |
| **Tenant Admin** | Delegated administrator within a tenant. | Manage users, stores, role assignments within the tenant. |
| **Store Manager** | Manages one or more stores for a tenant. | Operate within assigned store(s); cannot manage tenant-level settings. |
| **Store Staff** | Day-to-day user assigned to one or more stores. | Operate within assigned store(s); read-mostly on admin surfaces. |
| **POS Device** *(future)* | A registered device attached to a specific tenant + store, authenticated by a per-device credential. | Restricted to documented POS-facing endpoints. **Out of scope to implement here** — only the model accommodates it. |

> Roles above are the **default starter set**. Whether the system supports custom
> roles in v1 is an Open Question (Q2 below).

---

## 5. User Scenarios

### 5.1 Sign-in to the dashboard

**Given** an existing user with at least one tenant membership
**When** they authenticate with valid credentials
**Then** they receive an authenticated session
**And** the system identifies their available tenants
**And** if exactly one tenant exists, that tenant becomes the active context
**And** if multiple tenants exist, the user is prompted to choose one before any
  tenant-scoped resource can be read.

### 5.2 Switch active tenant

**Given** an authenticated user with memberships in multiple tenants
**When** they switch to another tenant
**Then** the active tenant context changes server-side
**And** any subsequent authenticated request resolves data only within the newly
  active tenant
**And** no resource fetched under the previous tenant remains addressable in the
  new context.

### 5.3 Switch active store within a tenant

**Given** an authenticated user with the active tenant set, and access to ≥1 store
**When** they select a store
**Then** the active store context is set server-side
**And** subsequent store-scoped requests resolve only within that store
**And** the store MUST belong to the active tenant; otherwise the switch is
  rejected.

### 5.4 Cross-tenant access attempt is rejected

**Given** user A has access to tenant T1 only
**When** user A's authenticated request references a resource under tenant T2
  (whether by direct ID, query, or by attempting to set active tenant = T2)
**Then** the backend MUST reject the request with an authorization error
**And** MUST NOT leak existence of T2's resources via response codes or messages.

### 5.5 Cross-store access attempt is rejected

**Given** user U is a member of tenant T with access only to store S1
**When** user U requests a resource scoped to store S2 in the same tenant T
**Then** the backend MUST reject the request with an authorization error
**And** MUST NOT leak the existence or attributes of S2.

### 5.6 Role-driven dashboard visibility never replaces backend enforcement

**Given** a Store Staff user
**When** they craft a request to a tenant-admin endpoint (e.g., user management)
  by hand, bypassing dashboard UI
**Then** the backend MUST reject the request based on server-side authorization,
  regardless of frontend role hints.

### 5.7 Tenant context is explicit, never inferred from frontend state

**Given** a request without a server-resolvable tenant context
**When** that request hits a tenant-scoped endpoint
**Then** the backend MUST reject it as unauthenticated/unauthorized
**And** MUST NOT fall back to "first tenant found" or any frontend-supplied hint
  that isn't cryptographically tied to the user's session/credential.

### 5.8 Inviting a user to a tenant

**Given** a Tenant Admin
**When** they invite an email address to their tenant with a role and store-access
  policy (all stores OR a specific store list)
**Then** the invitee, upon accepting, gains a membership in that tenant with the
  specified role and store-access policy
**And** the invite MUST be tenant-scoped — accepting an invite NEVER grants access
  to any other tenant.

### 5.9 Future POS device attachment (model-only)

**Given** the foundation is in place
**When** a future POS sync feature registers a device
**Then** the device record can attach to (tenant, store, user-or-service-identity)
  using existing identifiers
**And** no schema change to the foundation is required to support this attachment.

---

## 6. Functional Requirements

> Each requirement is testable. "MUST" = mandatory. "SHOULD" = strongly recommended,
> override requires written justification.

### 6.1 Identity & Authentication

- **FR-AUTH-1**: The system MUST identify each human actor by a unique user record
  with a stable identifier and a verified email or equivalent verified credential.
- **FR-AUTH-2**: The system MUST authenticate users via a primary credential
  (default assumption: email + password with industry-standard hashing). Alternate
  methods (SSO, OAuth, magic link) are non-blocking extensions.
- **FR-AUTH-3**: Authenticated sessions MUST have an explicit expiry and a
  documented refresh/extension mechanism.
- **FR-AUTH-4**: Failed authentication attempts MUST be rate-limited per
  account/IP per a documented policy.
- **FR-AUTH-5**: Password reset and email verification flows MUST exist and MUST
  not leak whether an email is registered.
- **FR-AUTH-6**: All authentication state MUST be revocable — admin-initiated
  session revocation, password change, or account suspension MUST invalidate
  active credentials within a documented bound (e.g., ≤5 minutes).

### 6.2 Tenancy

- **FR-TEN-1**: Every tenant-owned resource in the system MUST carry an explicit
  `tenant_id` and MUST NOT be addressable without a resolvable tenant context.
- **FR-TEN-2**: A user MAY belong to zero or more tenants. Membership is the only
  way a user gains tenant-scoped access.
- **FR-TEN-3**: Tenant membership MUST be backed by a `(user, tenant)` link
  carrying a role and a store-access policy (see FR-ACCESS).
- **FR-TEN-4**: The tenant identifier in any request MUST be either:
  (a) cryptographically tied to the session/credential, or
  (b) explicitly chosen via an authenticated context-switch endpoint and
      validated against the user's memberships.
- **FR-TEN-5**: Tenant deletion MUST be reversible for a documented retention
  window before any hard delete; soft-deletion is the default.
- **FR-TEN-6**: Cross-tenant operations (platform support, billing, analytics
  exports) MUST be auditable: each cross-tenant action records actor, source
  tenant, target tenant, action, and timestamp.

### 6.3 Stores / Branches

- **FR-STORE-1**: Every store MUST belong to exactly one tenant via a foreign-key
  relationship.
- **FR-STORE-2**: A tenant MAY have one or more stores; a tenant with zero stores
  is permitted (e.g., a newly created tenant pre-onboarding).
- **FR-STORE-3**: Store-scoped resources (anything that "belongs to a store")
  MUST carry both `tenant_id` and `store_id`. Both MUST be consistent — orphaned
  combinations are a defect.
- **FR-STORE-4**: A store cannot be moved across tenants; reassignment is
  effectively a delete-and-recreate flow with audit.
- **FR-STORE-5**: Soft-deletion applies to stores as it does to tenants.

### 6.4 Roles & Permissions

- **FR-ROLE-1**: The system MUST ship with a documented default role set, at
  minimum: **Owner**, **Tenant Admin**, **Store Manager**, **Store Staff**, plus
  the platform-level **Platform Admin**. (Final roster pending Q2.)
- **FR-ROLE-2**: Roles MUST encode authority levels distinguishing tenant-level
  authority (manage users/stores/settings) from store-level authority (operate
  within assigned stores).
- **FR-ROLE-3**: A user's role applies **per tenant** — the same user may be
  Tenant Admin in tenant A and Store Staff in tenant B. Roles are NOT global
  unless explicitly platform-level.
- **FR-ROLE-4**: Role-to-permission mapping MUST be documented and reviewed
  at the start of each milestone.
- **FR-ROLE-5**: All authorization decisions MUST be enforced server-side at the
  API boundary. Frontend role checks are UX hints only and MUST NOT be the sole
  gate on any protected action.

### 6.5 Store Access Within a Tenant

- **FR-ACCESS-1**: For each `(user, tenant)` membership, the system MUST record
  a store-access policy of one of the following kinds:
  - **All stores** in the tenant (current and future), or
  - **Specific stores** — a list of `store_id`s within the tenant.
- **FR-ACCESS-2**: The store-access policy MUST be evaluated server-side on
  every store-scoped request.
- **FR-ACCESS-3**: When a new store is created in a tenant, users with the
  "all stores" policy MUST gain access automatically. Users with a specific-stores
  policy MUST NOT gain access until explicitly added.
- **FR-ACCESS-4**: Removing a user's access to a store MUST invalidate any
  cached or in-flight authorization decisions within a documented bound.

### 6.6 Active Context (Tenant + Store)

- **FR-CTX-1**: Every authenticated request MUST resolve to at most one
  **active tenant** and at most one **active store**, both resolved server-side.
- **FR-CTX-2**: The active tenant MUST be a tenant the user is a member of.
- **FR-CTX-3**: The active store, if set, MUST be a store within the active
  tenant AND within the user's store-access policy.
- **FR-CTX-4**: A request that requires store scope but has no active store
  MUST be rejected with a clear, non-leaking error.
- **FR-CTX-5**: Switching active context MUST be an authenticated, audited
  action — not a frontend-only state change.
- **FR-CTX-6**: A request MAY be tenant-scoped without being store-scoped (e.g.,
  tenant-level settings, user management). Such requests MUST still validate
  active tenant and the user's tenant-level role.

### 6.7 Backend-Enforced Tenant Isolation

- **FR-ISO-1**: The data layer MUST enforce tenant scoping via foreign keys and
  (where supported) row-level security or equivalent constraints — NOT only by
  application code.
- **FR-ISO-2**: All ORM/query helpers MUST default to tenant-scoped queries.
  "Raw" cross-tenant queries require an explicit, code-reviewed override and
  are forbidden in user-request handlers.
- **FR-ISO-3**: Every endpoint touching tenant-owned data MUST have at least
  one automated test asserting that user A cannot read or mutate user B's
  tenant data, even when supplying B's resource identifiers directly.
- **FR-ISO-4**: Error responses MUST NOT distinguish "resource exists in another
  tenant" from "resource does not exist." Both cases return the same not-found /
  unauthorized response.

### 6.8 Audit & Observability

- **FR-AUDIT-1**: The following events MUST be recorded with actor, target
  tenant, target store (if any), action, and timestamp:
  authentication success/failure, role/permission change, store-access change,
  tenant context switch, tenant/store create/update/soft-delete, platform-admin
  cross-tenant access.
- **FR-AUDIT-2**: Audit records MUST be queryable by tenant for compliance
  exports.
- **FR-AUDIT-3**: Logs and audit records MUST NOT contain credentials, tokens,
  or PII beyond what is necessary to identify the actor.

### 6.9 Future POS Integration Seams (model-only)

- **FR-POS-SEAM-1**: The user/tenant/store/role model MUST allow a future POS
  device record to reference `(tenant_id, store_id)` and either a user or a
  service-identity without schema redesign.
- **FR-POS-SEAM-2**: The authentication subsystem MUST allow future per-device
  credentials issued by the backend (revocable, tenant+store+device-bound)
  without invasive changes to the user authentication path.
- **FR-POS-SEAM-3**: Idempotency-key handling for future POS write endpoints
  MUST be representable at the platform level (e.g., a documented mechanism
  for storing idempotency records keyed by tenant+store+device+key) — even if
  not yet implemented in this milestone.

> POS endpoints themselves are NOT defined in this spec. Only the structural
> seams that future POS work will attach to.

---

## 7. Key Entities (Conceptual Data Model)

> This is the **conceptual** model — names and relationships, not schema syntax.
> Implementation choices (table layout, ORM, indexes) belong in `/speckit-plan`.

| Entity | Purpose | Key Relationships |
|---|---|---|
| **User** | A human identity. | Has many `Membership`s. |
| **Tenant** | A customer account / organization. | Has many `Store`s; has many `Membership`s. |
| **Store** | A branch/location belonging to a tenant. | Belongs to one `Tenant`. |
| **Membership** | A user's relationship to a tenant. Carries the user's role in that tenant and a store-access policy. | One per `(User, Tenant)` pair. |
| **StoreAccess** | When a membership's policy is "specific stores," this links the membership to allowed stores. | Many per `Membership`; each references one `Store` of the membership's `Tenant`. |
| **Role** | A named bundle of capabilities (Owner, Tenant Admin, Store Manager, Store Staff, Platform Admin). | Referenced by `Membership`. |
| **Permission** *(optional in v1)* | A fine-grained capability that may compose roles or override them. | Pending Q2. |
| **Session** *(or Token)* | An authenticated session for a user, scoped to an active tenant and (optionally) active store. | Belongs to one `User`. |
| **AuditEvent** | An immutable record of a security/governance-relevant action. | References actor `User`, target `Tenant`, optional `Store`. |
| **Invitation** | A pending offer for a user to join a tenant with a role and store-access policy. | Belongs to one `Tenant`; referenced by zero or one accepted `User`. |
| **Device** *(future, seam only)* | A registered POS device. | Will reference `Tenant` + `Store` + (User or service identity). **Not implemented in this spec.** |

### Invariants

- **I-1**: For every `Store`, `Store.tenant_id` is non-null and references an existing `Tenant`.
- **I-2**: For every `Membership`, the `(user, tenant)` pair is unique.
- **I-3**: For every `StoreAccess`, the referenced `Store.tenant_id` equals the parent `Membership.tenant_id`.
- **I-4**: An active store on a session/token implies the active tenant equals the store's tenant.
- **I-5**: Soft-deleted tenants/stores/memberships are not accessible to non-platform-admin actors.

---

## 8. Success Criteria

> Measurable, technology-agnostic outcomes. Verified before this feature is
> considered "done."

- **SC-1 — Cross-tenant isolation**: 100% of tenant-scoped endpoints reject
  cross-tenant access in automated tests; zero exceptions.
- **SC-2 — Cross-store isolation**: 100% of store-scoped endpoints reject
  cross-store access in automated tests; zero exceptions.
- **SC-3 — Authorization coverage**: Every protected endpoint has at least one
  test for: unauthenticated, authenticated-but-wrong-tenant, authenticated-but-wrong-store
  (where applicable), and authenticated-but-insufficient-role.
- **SC-4 — Server-only authorization**: A documented manual probe (curl-style
  request bypassing the dashboard) confirms that no protected operation is
  accessible based on frontend role hints alone.
- **SC-5 — Context resolution time**: For 95% of authenticated requests, the
  server resolves active tenant + active store + role + permissions in under a
  perceptible threshold (target: ≤50ms median, ≤200ms p95 — measured end-to-end
  excluding business logic).
- **SC-6 — Onboarding clarity**: A new tenant admin can invite a user, assign a
  role, choose a store-access policy, and have the user complete sign-in — via
  documented onboarding flows (API-ready; the dashboard UI implementing them is
  a separate feature) — in under 5 minutes from invite send.
- **SC-7 — Auditability**: 100% of role/permission/access changes are
  retrievable from the audit log per tenant for at least the documented
  retention period.
- **SC-8 — Reusability for POS**: A walkthrough document demonstrates how a
  hypothetical POS sync endpoint would attach to the existing tenant/store/user
  model with no schema changes to the foundation.
- **SC-9 — No frontend-only gates**: Code review checklist for every PR in this
  milestone explicitly verifies "no protected action gated solely by frontend
  state"; 0 violations at merge time.

---

## 9. Assumptions (with rationale)

> Reasonable defaults applied where the user did not specify. Each can be
> revisited in `/speckit-clarify` if needed.

- **A-1**: Email + password is the primary authentication method for human users.
  SSO/OAuth/magic-link are valid future extensions but not blocking.
- **A-2**: Sessions for the dashboard are server-validated (cookie-based or token-based,
  decided in `/speckit-plan`). The choice does not change spec behavior.
- **A-3**: A user with zero tenant memberships can authenticate but has no
  tenant-scoped capability — they remain in an awaiting-invite / no-tenant-access
  state unless a future self-signup tenant-creation flow is explicitly specified
  (see Q1).
- **A-4**: "Active store" is optional even when active tenant is set; tenant-level
  admin work doesn't require a store context.
- **A-5**: Soft-deletion is the default for tenant, store, membership, and user;
  hard-delete is a privileged, audited platform-admin action after a retention
  window.
- **A-6**: PostgreSQL is the system of record per Constitution Principle III; all
  isolation invariants will be enforceable by FK + constraints + (where applicable)
  RLS.
- **A-7**: The platform-admin role is intentionally minimal — used for support
  and billing operations only, with full audit trail. It is not a daily-use role.
- **A-8**: Default-deny is the rule for every authorization decision; absence of
  a permission means "denied," not "allowed."
- **A-9**: "All stores" access policy is implemented as a flag on the membership,
  not by enumerating every store, so future store creations are automatically
  covered.
- **A-10**: Tenant onboarding (Q1) is assumed **invite-only by platform admin**
  for v1 — see Open Questions for self-signup option.
- **A-11**: Roles in v1 are assumed **fixed/predefined** (Q2) — see Open Questions
  for full custom RBAC option.
- **A-12**: Active context (Q3) is assumed **server-resolved per session, switchable
  via an authenticated context-switch endpoint** — not multiple parallel sessions.

---

## 10. Open Questions

> Material decisions that will shape `/speckit-plan`. Listed for the user to
> resolve via `/speckit-clarify` (or by direct decision) before planning.

### Q1 — Tenant onboarding model

**Context**: Users belong to tenants, but the spec doesn't say how a brand-new
tenant comes into existence.

**Options**:
- **A**: Invite-only by platform admin. New tenants created via internal/admin tool.
  *Implication*: tighter control, slower self-service growth.
- **B**: Public self-signup creates a new tenant with the signing-up user as Owner.
  *Implication*: faster growth, requires anti-abuse measures (email verification,
  rate-limiting, captcha).
- **C**: Hybrid — self-signup gated by waitlist or invite code.

**Default applied**: **A** (per Assumption A-10).

### Q2 — Role model: fixed vs custom RBAC

**Context**: FR-ROLE-1 lists default roles. Real customers often want to define
their own.

**Options**:
- **A**: Ship fixed predefined roles only (Owner / Tenant Admin / Store Manager /
  Store Staff). *Implication*: simple v1, fast to ship; customers may outgrow it.
- **B**: Ship roles as compositions of permissions; allow custom roles per tenant.
  *Implication*: more design work, more test surface, more admin UI complexity;
  longer-term flexibility.
- **C**: Hybrid — fixed roles in v1 with a documented forward-compat permission
  table so custom roles ship later without migration pain.

**Default applied**: **C** (predefined roles in v1, but the data model leaves
room for fine-grained permissions). This is implied by FR-ROLE-4 +
"Permission *(optional in v1)*" in §7.

### Q3 — Active tenant/store context mechanism

**Context**: FR-CTX-1 says context is server-resolved. The exact mechanism
matters for both UX and security.

**Options**:
- **A**: One session, switchable via an authenticated context-switch endpoint.
  Active context lives server-side, keyed by session.
  *Implication*: simple UX (one login covers all tenants); requires careful
  audit on every switch.
- **B**: Separate session/token per tenant. Switching tenants = re-authenticating
  or selecting a different stored token.
  *Implication*: stronger isolation by construction; clunkier UX for users with
  multiple tenants.
- **C**: Token encodes active tenant; switching = mint a new token via an
  authenticated context-switch endpoint.
  *Implication*: stateless-friendly; requires token revocation strategy.

**Default applied**: **A** (per Assumption A-12).

---

## 11. Out of Scope (explicit)

To avoid scope creep, the following are **explicitly excluded** from this spec
and any plan/tasks generated from it:

- POS application UI, offline behavior, or local sync client (separate repo).
- POS sync API endpoints (foundation only — no routes, no payloads).
- Product catalog, inventory, orders, payments.
- Reports, analytics dashboards, dbt models.
- Billing, subscriptions, plan limits, metering.
- Webhooks and external integrations.
- Background workers (the platform's worker stack will be defined in a later
  spec; this foundation does not require workers to exist yet).
- Frontend (dashboard) implementation. The dashboard's *contracts* with the
  backend are defined here, but UI work is a separate feature.
- Any code at all in this step.

---

## 12. Dependencies

- **Constitution v3.0.0** (`.specify/memory/constitution.md`) — this spec is
  authored under and validated against it. Constitution Check (§14) is
  mandatory for all plan/task work derived from this spec.
- **PostgreSQL** as the system of record (Constitution Principle III).
- **No external service dependency** required to ratify the spec itself; SSO/email
  delivery providers will be chosen in `/speckit-plan` if relevant.

---

## 13. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | Tenant data leakage via missing scope on a single endpoint. | FR-ISO-1/2/3: defense in depth (DB + ORM defaults + per-endpoint isolation tests). For the exhaustive scenario catalog — including B-class cross-tenant non-disclosure probes and G-class RLS bypass probes — see [`tenant-isolation-matrix.md`](./tenant-isolation-matrix.md) §6 and §11. |
| R-2 | Performance degradation if every request resolves full role+permission state. | SC-5 defines the budget; plan must include a caching strategy that is reconstructible from Postgres (Constitution Principle III). |
| R-3 | Role model picked for v1 doesn't fit real customers. | Q2 default (C) leaves room for permission-based custom roles later without schema redesign. |
| R-4 | Active-context switch races (user switches tenant mid-flight, in-flight requests touch the wrong tenant). | FR-CTX-5 requires server-side switch + audit; plan must define request lifetime semantics for in-flight context. |
| R-5 | Future POS work forced to redesign the foundation. | FR-POS-SEAM-1/2/3 + SC-8 walkthrough; plan must include a documented seam check. |

---

## 14. Constitution Check

Against `.specify/memory/constitution.md` v3.0.0:

| Principle | How this spec satisfies it |
|---|---|
| I. Reference, Not Source of Truth | Spec is written from current requirements, not lifted from legacy repo. |
| II. Multi-Tenant SaaS by Default | Entire spec is about making this true at the data and API layers. |
| III. Backend Authority & Data Integrity (NON-NEGOTIABLE) | FR-ISO-1, FR-CTX-1, FR-AUTH, FR-ROLE-5 all enforce server-side authority. |
| IV. Contract-First POS Integration | §6.9 + §10 Q3 + SC-8 ensure POS seams exist; no POS endpoints defined here. |
| V. Async Work Belongs in Workers | No synchronous work pushed inappropriately into this spec. |
| VI. Test-First Quality | SC-1/2/3/9 specify the test posture; plan/tasks will write tests first. |
| VII. Observable Systems | FR-AUDIT-1/2/3 require structured audit + non-leaky logs. |
| VIII. Reproducible & Versioned Releases | Spec is versioned (v0.1 draft); migrations follow the constitution rules in plan. |
| IX. Source-of-Truth Model | Not exercised by this feature — foundation owns identity/tenancy only; catalog / sales entities (where Global / Tenant / Store / SaleLine boundaries apply) are out of scope per §3 and §11. The SaaS-as-truth half (tenants, stores, memberships, integration credentials) is seeded by §7 entities. |
| X. Retail Temporal Semantics | Not exercised — no sale, order, or POS-event entities are defined here. The spec acknowledges future POS events via FR-POS-SEAM-3; per-entity timestamp catalogs bind future specs. |
| XI. Idempotency & External IDs | Spec satisfies the seam — FR-POS-SEAM-3 mandates platform-level idempotency representation (`(tenant, store, client, key)`). Real endpoints consuming it are out of scope here; full implementation binds plan/task work. |
| XII. Authorization & Object Safety | Spec satisfies — FR-CTX-1, FR-CTX-4, FR-ISO-1..4, and FR-ROLE-5 codify server-side tenant/store resolution, default-deny, and FR-ISO-4 safe-404 for cross-tenant lookups. Mass-assignment defense binds plan/task work. |
| XIII. Auditability & Provenance | Spec satisfies — FR-AUDIT-1..3 define auditable events, the no-PII-leak rule, and tenant-queryable audit. Anonymous-actor pattern, insert-only posture, and ingestion provenance bind plan/task work. |
| XIV. PII & Data Lifecycle Discipline | Spec satisfies posture — FR-AUDIT-3 forbids PII in logs; FR-TEN-5 / FR-STORE-5 / A-5 require soft-delete with reversible retention. Full data classification taxonomy and right-to-erasure flows bind future specs. |

No principle violations identified at the spec level. Plan-level Constitution
Check is a separate gate.

---

## 15. Acceptance Criteria (consolidated)

The foundation is "spec-complete" when:

- All fourteen Constitution principles are satisfied (§14).
- All nine Functional Requirement groups (§6.1–§6.9) are present and testable.
- Open Questions Q1/Q2/Q3 are either resolved or explicitly accepted at their
  default per Assumption A-10/A-11/A-12.
- Success Criteria SC-1 through SC-9 are agreed by the owner.
- An auditor can read this spec without consulting the legacy Data-Pulse repo.

---

**End of specification.**
