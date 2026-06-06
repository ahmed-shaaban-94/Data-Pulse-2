# Implementation Plan: Connector Boundary Hardening v1

**Branch**: `feat/018-connector-boundary-hardening` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/018-connector-boundary-hardening/spec.md` (+ clarifications Session 2026-06-06) and the approved brainstorm design [docs/superpowers/specs/2026-06-06-018-connector-boundary-hardening-design.md](../../docs/superpowers/specs/2026-06-06-018-connector-boundary-hardening-design.md).

## Summary

Harden the DP2↔ERPNext-Connector boundary for safe pilot operation. Add a stable **connector instance identity** (a new `[GATED]` `connector_registration` table) that survives credential rotation; keep credentials in the existing `auth_tokens` store, linked by a new nullable `connector_registration_id` FK. Provide operator-safe **issue / rotate / revoke** credential flows (atomic immediate-revoke rotation; at-most-one active credential per registration) and **disable** for a whole instance (logical, audit-preserving). Tighten `ConnectorAuthGuard` to resolve + validate the full registration-linked usability rule and attach the calling instance identity, with non-disclosing rejection — without touching the generic dashboard/POS token path. Audit every lifecycle action (raw secret never logged; shown once at issue/rotate) and emit an unlabeled lifecycle counter. Produce a boundary-of-record doc pinning the existing 012 posting feed/ack contract + the A–E future-surface ownership table. **Gates pre-approved by owner 2026-06-06.**

## Technical Context

**Language/Version**: TypeScript 5.x strict, Node.js 20 LTS (existing DP2 stack).

**Primary Dependencies**: NestJS 11 (api), Drizzle ORM, PostgreSQL 16+ with RLS, Zod (runtime validation), argon2 (the existing token-hash path — connector secrets hashed like other opaque bearer tokens), pino (redacted logging). No new runtime dependency.

**Storage**: PostgreSQL — one new table `connector_registration`; one new nullable column + FK on the existing `auth_tokens`; reuse of `audit_events`. Migration `0021` (next free after `0020`).

**Testing**: Jest + Supertest + Testcontainers (WSL-only, `reference_007_test_env`); `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs. RLS / cross-tenant / mass-assignment coverage per §VI.

**Target Platform**: Linux server (api). DP2 backend only.

**Project Type**: Web service (NestJS api + worker monorepo). This feature is **api-side only** (no worker changes; the connector posting endpoints already live in `apps/api`).

**Performance Goals**: Not a hot path — lifecycle operations are low-frequency operator actions; the guard adds one indexed lookup per connector request (the connector polls on an interval, not per-sale). No perf env; report-only if measured (the 005/008/009/010/015/017 precedent).

**Constraints**: No outbound ERPNext HTTP from DP2 (ADR 0008). Money/PII never on the credentialing surface (§XIV). Non-disclosing errors (§II cross-tenant). Reuse the opaque-bearer auth primitive, do not invent a new one.

**Migration / rollout hazard (load-bearing — finding GUARD-TIGHTENING-IS-BREAKING-FOR-LEGACY-TOKENS):** US4 tightens the guard to reject a `connector`-scoped token with no `connector_registration_id`. This enforcement is **independent of the DB CHECK** — the connector is already built with an activated poller (connector PR #23), so any pre-existing hand-issued connector token in an environment the connector talks to would be cut off the moment US4 ships there. The **T010 preflight gates US4** (not just T012's CHECK): if a pre-existing connector token is found, the safe sequence is backfill-a-registration → link-or-reissue → reconfigure-the-connector, *before* US4 reaches that environment. 017-VERIFY records the cross-system leg never ran live, so the preflight may well be clean — which is exactly why it must be run and must gate US4.

**Scale/Scope**: A handful of connector instances per tenant (typically one per environment). Credential rows are bounded (at-most-one active per registration + revoked history).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Relevance | Compliance |
|---|---|---|
| **II — Multi-tenant RLS** | `connector_registration` is tenant-owned. | NOT NULL `tenant_id` + FK; fail-closed RLS (empty-GUC CASE guard), mirroring `0019`/`0020`. Runtime role never BYPASSRLS. Cross-tenant probe → non-disclosing (FR-016). ✅ |
| **III — Backend authority & integrity** | Registration/credential rules are server-enforced; uniform error envelope. | Uniqueness, environment enum, at-most-one-active = DB constraints (CHECK / partial-unique), not app hints. Canonical error envelope on the admin surface. Immutability: credentials are append-then-revoke, never mutated in place beyond `revoked_at`. ✅ |
| **IV — Contract-first / no raw entities** | Admin surface + the credential response. | Responses are explicit wire shapes; **credential hashes / raw secrets MUST never appear in responses** (FR-007/021) — directly the §IV rule. If the admin surface is REST, its OpenAPI is `[GATED]` (pre-approved). ✅ |
| **III — Backend authority (authorization)** | Privileged admin surface. | Issue/rotate/revoke/disable are privileged credential-minting ops — gated by TWO orthogonal checks: **human-session-only** (a new session-only guard that rejects `principal.kind==="token"`, incl. `dashboard_api` bearer — FR-005c) AND **role** (`RolesGuard` `@Roles("owner","tenant_admin")` — FR-005b), + `TenantContextGuard`, default-deny → 404. 018 is STRICTER than its 014/017 precedent: those gate by role but allow `dashboard_api` bearers; a connector-credential-minting surface must not accept another machine bearer. `DashboardAuthGuard` is NOT used here (it allows `dashboard_api`). ✅ |
| **VI — Test-first** | Tenant isolation + mass-assignment. | Testcontainers RLS sweep (cross-tenant → 0 rows); body/query-supplied tenant rejected (FR-018); mass-assignment ban on registration create. RED→GREEN. ✅ |
| **VIII — Reproducible / `[GATED]`** | Migration + (maybe) OpenAPI. | `0021` migration + paired `*.down.sql`; the two-allowlist regression (cli/migrate + barrel). **Gates pre-approved** but each `[GATED]` artifact is still named explicitly. ✅ |
| **XII — Object safety / mass-assignment** | Registration create. | Strict DTO; client cannot set tenant, id, disabled state, or created_by. ✅ |
| **XIV — PII / data class** | Credential surface. | Registration + credential are BUSINESS-class; **no PII, no money, no raw secret column** (FR-022); audit + signal redacted. ✅ |

**Result: PASS.** No violations; Complexity Tracking not required. One new table + one FK column is the minimal surface for stable-identity-across-rotation (the rejected alternatives — all-on-`auth_tokens`, or a full registry subsystem — are recorded in the design doc §1 and research.md).

## Project Structure

### Documentation (this feature)

```text
specs/018-connector-boundary-hardening/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions + rationale + rejected alternatives
├── data-model.md        # Phase 1 — connector_registration + auth_tokens link + invariants
├── quickstart.md        # Phase 1 — how to exercise/verify each user story
├── contracts/           # Phase 1 — boundary-of-record doc (+ admin OpenAPI iff REST chosen)
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/db/
├── src/schema/
│   ├── connector_registration.ts        # [GATED] new table (Drizzle)
│   ├── auth_tokens.ts                    # [GATED] add nullable connector_registration_id FK
│   └── index.ts                          # barrel re-export (+ EXPECTED_* allowlist updates in tests)
├── drizzle/
│   ├── 0021_connector_registration.sql       # [GATED] migration (UP)
│   └── 0021_connector_registration.down.sql  # [GATED] paired DOWN
└── __tests__/...                         # migration round-trip + cli/migrate allowlist + barrel

apps/api/src/
├── connector/                            # new module — connector registration + credential lifecycle
│   ├── connector-registration.controller.ts   # admin surface: SESSION-ONLY (human cookie only, reject dashboard_api bearer) + TenantContextGuard + RolesGuard @Roles("owner","tenant_admin") [iff REST]
│   └── session-only-admin.guard.ts             # new — rejects principal.kind==="token" (incl. dashboard_api); no existing session-only guard (DashboardAuthGuard allows dashboard_api)
│   ├── connector-registration.service.ts       # register/list/disable + issue/rotate/revoke
│   ├── connector-credential.repository.ts       # connector-only credential lookups/writes
│   └── dto/*.ts                                  # strict request/response wire shapes
├── auth/
│   ├── connector-auth.guard.ts           # TIGHTEN — resolve registration link + attach identity
│   └── auth-token.repository.ts          # add findActiveConnectorCredentialByRawToken (connector-only path)
└── observability/metrics/api.metrics.ts  # add the unlabeled connector lifecycle counter (shared file)

apps/api/test/connector/                  # isolation sweep, lifecycle, guard, audit specs
```

**Structure Decision**: api-side only (no worker), one new `apps/api/src/connector/` module mirroring the 013/014/017 catalog-module shape but under a connector namespace (it is auth/identity, not catalog). Schema lives in `packages/db` (the `[GATED]` half). The connector posting endpoints stay where they are (`catalog/erpnext-posting`); 018 only tightens their guard.

## Phase 0 — Research (→ research.md)

No `NEEDS CLARIFICATION` remain (the design doc + clarifications resolved them). research.md records the load-bearing decisions + rejected alternatives:
- **Identity model** = thin `connector_registration` table + `auth_tokens` FK (Approach A); reject all-on-`auth_tokens` (loses identity across rotation) and full registry subsystem (YAGNI for v1).
- **Rotation** = immediate-revoke, atomic, at-most-one-active; the DB invariant is `UNIQUE (connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL` (immutable predicate — avoids the `now()`-not-IMMUTABLE partial-index trap); expiry enforced at the guard, not the constraint.
- **CHECKs preflight-gated** — scope enum + connector-token consistency (`scope='connector'` iff link present); stray/legacy rows → STOP for owner decision (the two carried open questions).
- **Admin surface form** (open question 4) — REST `[GATED]` OpenAPI vs CLI/seed; research recommends REST for operator usability, decided at task time (gate pre-approved).
- **Auth reuse** — connector secret hashed via the existing opaque-bearer path; no new primitive.

## Phase 1 — Design & Contracts (→ data-model.md, contracts/, quickstart.md)

- **data-model.md** — `connector_registration` columns + CHECKs (environment enum, non-empty display_name, the `(tenant_id, environment, erpnext_site_ref)` unique from clarification Q1); `auth_tokens` + `connector_registration_id` FK (RESTRICT); the at-most-one-unrevoked partial-unique; RLS policies (fail-closed); the usability predicate; audit + signal shape. No money/PII column.
- **contracts/** — the **boundary-of-record doc** (FR-023/024: the existing 012 feed/ack auth/idempotency/replay/error/non-disclosure rules + the A–E ownership table). The admin OpenAPI is authored here **iff** REST is chosen at task time (gate pre-approved); otherwise the admin surface is documented as the operator-tool contract.
- **quickstart.md** — per-user-story verification (register+issue, rotate/revoke, disable, guard enforcement, boundary doc) under WSL Testcontainers.
- **Agent context** — update the `<!-- SPECKIT START/END -->` block in CLAUDE.md to point at this plan (and, opportunistically, fix the stale "connector is LICENSE+README only" line — it is demonstrably false).

## Phase 2 — Tasks (NOT created here)

`/speckit-tasks` generates `tasks.md` + `execution-map.yaml`: SIGNOFF → SETUP → `[GATED]` SCHEMA (`0021`) + `[GATED]` CONTRACT (boundary doc + admin OpenAPI iff REST) → ISOLATION-HARNESS → US1 (register+issue 🎯) → US2 (rotate/revoke) → US3 (disable) → US4 (guard enforcement) → US5 (boundary doc) → POLISH (signal + coverage + closeout). Gated slices are pre-approved but remain explicitly marked; the preflight stop-on-stray-rows discipline applies at SCHEMA time.

## Complexity Tracking

No constitution violations — section intentionally empty.
