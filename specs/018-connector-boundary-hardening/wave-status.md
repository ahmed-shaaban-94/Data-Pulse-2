# Wave Status — `018-connector-boundary-hardening`

> Human-readable status. 018 is **DP2-owned Connector Boundary Hardening v1**: now
> that the ERPNext connector is real and posting, make it safely **operable** for a
> tenant pilot — connector instance identity, credential lifecycle, a tightened
> guard, audit + signal, and a boundary-of-record doc. **Not** live stock read (019),
> **not** scheduled reconciliation (029), **not** fiscal (016).

**Last updated:** 2026-06-06 by Ahmed Shaaban — **planning chain authored** on `feat/018-connector-boundary-hardening` (spec → clarify → plan → research → data-model → contracts → tasks → execution-map). **Gates owner-approved in-session 2026-06-06.** No slice dispatched yet.
**Spec:** `018-connector-boundary-hardening`
**Base:** `feat/018-connector-boundary-hardening` off `origin/main` (012 posting-feed SHIPPED; 015 + 001 auth on main; 017 CLOSED).
**Status:** PLANNING COMPLETE, gates pre-approved, ready to dispatch (or merge the planning chain first).

## SIGN-OFF Decisions (018-SIGNOFF, T001 — recorded 2026-06-06)

- **Approach A** — stable identity in a thin `[GATED]` `connector_registration` table; credentials stay in `auth_tokens` (+ nullable `connector_registration_id` FK, RESTRICT) — a link, not connector metadata. Identity survives rotation. (Rejected: all-on-`auth_tokens`; full registry subsystem.)
- **Rotation** — immediate-revoke, atomic, **at-most-one active per registration**. DB invariant `UNIQUE (connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL` (immutable predicate; expiry enforced at the guard, not the predicate — `now()` is not IMMUTABLE).
- **CHECKs preflight-gated** — scope enum + connector-token consistency; stray/legacy rows STOP for owner (research R3). 
- **Clarifications (Session 2026-06-06):** site uniqueness ENFORCED on `(tenant, environment, erpnext_site_ref)`; credential expiry 90d default + ceiling; unlabeled lifecycle counter on the shared metrics surface.
- **Auth** — cookieAuth human Tenant Admin admin surface (NOT connectorBearer); REST-vs-CLI decided at the CONTRACT slice. Reuse the opaque-bearer primitive; no new primitive. DP2 makes NO outbound ERPNext HTTP.
- **Gates** — both `[GATED]` slices (`018-SCHEMA` packages/db `0021`; `018-CONTRACT` packages/contracts admin OpenAPI iff REST) **owner-approved 2026-06-06**; preflight discipline still applies at SCHEMA.

## /speckit-analyze result (2026-06-06)

**0 critical / 0 high / 0 medium.** 5 LOW findings, all intentional or cosmetic: US4-after-US1 ordering (explained inline — US4 needs an issued credential to enforce against); SC-001 non-buildable UX outcome (covered implicitly by US1); FR-012 expiry ceiling value pinned at implementation (T042 constant); admin REST-vs-CLI deferred to T021 (gated decision point); environment prose-vs-enum token wording (`development`→`dev` etc., harmless). Coverage: 100% of 29 FR have ≥1 task; buildable SCs covered; 0 unmapped tasks; 0 constitution conflicts (plan's PASS corroborated — §IV credential-hash-never-in-response directly mirrored by FR-007/021).

## Codex review (PR #514, 2026-06-06) — 2 findings, both ADDRESSED

- **P1 (authorization gap):** the admin surface was specced behind `DashboardAuthGuard` alone — which authenticates *any* dashboard principal / `dashboard_api` bearer but does not enforce tenant role. Credential issuance is privileged. **Fixed:** added FR-005b + the `DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard` `@Roles("owner","tenant_admin")` gate (default-deny → 404, the **014/017 controller precedent**) across plan/data-model/tasks (T040/T044/T062/T071) + execution-map US1 validation/stop-conditions; tests cover the non-admin + `dashboard_api`-bearer denial cases.
- **P2 (dispatch-vs-security-sequence gap):** US2/US3 validation asserts revoked/disabled creds are rejected on the connector endpoints — which requires the tightened guard (US4) — but their `depends_on` listed only US1, letting Maestro dispatch them before US4. **Fixed:** added `018-US4-GUARD` to both `018-US2-ROTATE-REVOKE` and `018-US3-DISABLE` `depends_on`.

**Round 2 (commit `8efd64e` re-review) — 1 finding, ADDRESSED:**

- **P1-round2 (the role gate is insufficient):** `DashboardAuthGuard` ALLOWS `principal.kind==="token" && scope==="dashboard_api"` (verified, guard line 36), and `RolesGuard` only checks role — so an owner/tenant_admin holding a `dashboard_api` machine bearer would pass both, making FR-005b's "dashboard_api bearer denied" test unsatisfiable by the prescribed wiring (an internal contradiction). **Fixed:** added **FR-005c** (human-session-only — authorization is now TWO orthogonal checks: principal KIND = session-only AND ROLE = owner/tenant_admin) + a new **session-only admin guard** (`session-only-admin.guard.ts`, task T044a — rejects `principal.kind==="token"` incl. `dashboard_api`; no such guard existed). 018 is deliberately STRICTER than its 014/017 precedent (which tolerates `dashboard_api`): a connector-credential-minting surface must not accept another machine bearer. `DashboardAuthGuard` is NOT used on this surface. Propagated to spec/plan/data-model/tasks (T040/T044a/T044/T062/T071)/execution-map.

## Slices (execution-map.yaml)

| Slice | Gate | Status |
|---|---|---|
| `018-SIGNOFF` | `[SIGN-OFF]` | ready (decisions above) |
| `018-SETUP` | — | ready |
| `018-SCHEMA` | `[GATED]` `packages/db` (`0021`) | proposed (owner-approved; preflight-gated CHECKs) |
| `018-CONTRACT` | `[GATED]` `packages/contracts` (admin OpenAPI iff REST) | proposed (owner-approved) |
| `018-ISOLATION-HARNESS` | — | blocked (waits SCHEMA) |
| `018-US1-REGISTER-ISSUE` 🎯 | — | blocked (MVP) |
| `018-US4-GUARD` | — | blocked (P1 security backbone) |
| `018-US2-ROTATE-REVOKE` | — | blocked |
| `018-US3-DISABLE` | — | blocked |
| `018-US5-BOUNDARY-DOC` | — | blocked |
| `018-POLISH` | — | blocked |

## Dependencies & gates (verified 2026-06-06 against `main`)

| Gate | State |
|---|---|
| 012 `posting-feed.yaml` (read-only input) | ✅ SHIPPED |
| 015 `auth_tokens` `connector` scope + `ConnectorAuthGuard` | ✅ on main |
| 001 auth: `auth_tokens`, opaque-bearer, `DashboardAuthGuard`, `audit_events` | ✅ on main |
| `[GATED]` `018-SCHEMA` (`0021`) | ✅ owner-approved 2026-06-06 (preflight still gates the CHECKs) |
| `[GATED]` `018-CONTRACT` (admin OpenAPI iff REST) | ✅ owner-approved 2026-06-06 |

## Out of scope → named future specs

019 (live ERPNext-Bin stock-view contract = the 017-deferred `017-STOCK-VIEW-CONTRACT`) · 020 (connector health/status) · 023 (sales-posting command, if a gap over 012 is proven) · 016 (tax/fiscal, on hold) · 029 (scheduled reconciliation) · connector-repo counterpart (consumes this boundary, authored after 018).

## Next recommended action

Dispatch order (each its own feature branch, per-slice commit/PR, owner merges — the 015/017 cadence): `018-SIGNOFF` → `018-SETUP` → the `[GATED]` pair `018-SCHEMA` + `018-CONTRACT` (owner-approved; **run T010 preflight first** — STOP on stray rows) → `018-ISOLATION-HARNESS` → `018-US1-REGISTER-ISSUE` 🎯 + `018-US4-GUARD` (the MVP pair) → `018-US2-ROTATE-REVOKE` → `018-US3-DISABLE` → `018-US5-BOUNDARY-DOC` → `018-POLISH`.
