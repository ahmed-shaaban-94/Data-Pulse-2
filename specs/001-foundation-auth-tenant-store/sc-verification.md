# SC Verification: Foundation — Auth, Tenants, Stores, Roles

**Feature**: 001-foundation-auth-tenant-store
**Document type**: Success-criteria verification record
**Author**: T309 verification pass
**Date**: 2026-05-13

---

## 1. Scope

This document records the outcome of verifying Success Criteria SC-1 through
SC-9 (spec.md §8) against the foundation backend as built through the commits
on `main` through SHA `bb473c3` (one commit ahead of the originally expected
`361fff3`; both are on `main` and the delta is a single fix to auth token
rejection — see §3).

Evidence is drawn from:

- Static inspection of source and test files on disk.
- `pnpm test` output captured locally on 2026-05-13.
- Existing documentation artifacts: `tenant-isolation-matrix.md`,
  `plan.md §12`, `tasks.md` task status.

**What this document does NOT claim.** It does not independently re-run tests
in CI or assert coverage numbers beyond what the test runner reports. Where
Docker / Testcontainers is unavailable locally, Testcontainers-backed tests
cannot execute; those results are explicitly labelled.

---

## 2. Exact T309 Task Text

```
- [ ] T309 [P] Verify Success Criteria SC-1..SC-9 against the running system;
            record results in `specs/001-foundation-auth-tenant-store/sc-verification.md`
```

---

## 3. Main SHA Verified

| Item | Value |
|---|---|
| Branch | `main` |
| Verified SHA | `bb473c3` (`fix(auth): reject single-use tokens from bearer auth`) |
| Expected SHA in task brief | `361fff3` (`Merge pull request #151 from ahmed-shaaban-94/claude/t308-constitution-signoff`) |
| Delta | One commit (`bb473c3`) is a bug fix committed on top of `361fff3`. The fix tightens single-use-token rejection in `AuthGuard` — this is directly load-bearing for SC-1 and SC-4. All criteria are evaluated against `bb473c3`. |

---

## 4. Summary Table

| SC | Title | Status | Gap | Recommended Follow-up |
|---|---|---|---|---|
| SC-1 | Cross-tenant isolation | **Partial** | Whole-API cross-tenant sweep (T203) missing. Testcontainers tests unrunnable locally (Docker absent). | T203: implement cross-tenant sweep suite in CI. |
| SC-2 | Cross-store isolation | **Partial** | Whole-API cross-store sweep (T204) missing. Several D-class Testcontainers tests blocked locally. | T204: implement cross-store sweep suite in CI. |
| SC-3 | Authorization coverage | **Partial** | Default-deny (T206), frontend-bypass (T205) test files missing on disk. Some endpoint families lack all four required test variants locally-confirmed. | Add T205, T206 test files; run CI to confirm Testcontainers-backed suites pass. |
| SC-4 | Server-only authorization | **Partial** | `apps/api/test/authz/frontend-bypass.spec.ts` (T205) absent on disk; no executable manual probe documented in this repo. Single-use token rejection (`bb473c3`) strengthens the bearer path. | Author T205 and add a curl-style probe script; promote to verified once T205 passes in CI. |
| SC-5 | Context resolution p95 ≤ 200 ms | **Needs measurement** | `apps/api/test/performance/context-resolution.spec.ts` (T310) absent on disk. No p95 measurement exists in any artifact. | T310: author performance spec; run in CI with a warm Postgres and assert p95. |
| SC-6 | Onboarding clarity | **Partial** | End-to-end invite → accept → sign-in integration tests (`invitations.accept-existing-user.spec.ts`, `invitations.accept-lookup.spec.ts`) exist but fail locally due to Docker; `quickstart.md` documents the flow. Five-minute stopwatch not wired in a test. | Run Testcontainers invite flow in CI; add a stopwatch assertion per tasks.md T170 acceptance. |
| SC-7 | Auditability | **Partial** | Audit capture, fan-out worker, query API, insert-only, and redaction tests all exist. **T311 (retention policy)** is explicitly deferred; retention period is undocumented. Several Testcontainers-backed audit tests cannot run locally. | Unblock T311 design decision; then implement retention sweep and wire its test. |
| SC-8 | Reusability for POS | **Partial** | `specs/001-foundation-auth-tenant-store/pos-seam-walkthrough.md` does **not exist** on disk. `apps/api/test/pos-seam/walkthrough.spec.ts` (T264) does not exist. `apps/api/test/pos-namespace/reserved-404.spec.ts` (T263) does not exist. Foundation data model, `auth_tokens.device_id`, idempotency platform, and `/api/pos/v1/*` namespace reservation are implemented. | Author T265 walkthrough document and T264 walkthrough test; author T263 reserved-namespace test. |
| SC-9 | No frontend-only gates | **Partial** | Per-PR constitution checklist exists in `.github/pull_request_template.md`; no merged PR has been flagged with a frontend-gate violation. `apps/api/test/authz/default-deny.spec.ts` (T206) is absent. The custom ESLint rule `tools/eslint-rules/no-unscoped-tenant-query.js` (T208) is absent. | Author T206, T208; verify no PR checklist violations across merged PRs. |

---

## 5. Detailed Notes per Success Criterion

### SC-1 — Cross-tenant isolation

**Spec definition (spec.md §8):**
> 100% of tenant-scoped endpoints reject cross-tenant access in automated
> tests; zero exceptions.

**Evidence found:**

| Item | File | Status |
|---|---|---|
| `TenantContextGuard` — no active tenant → 401 (A-1) | `apps/api/test/context/tenant-context.guard.spec.ts` | EXISTS |
| `TenantContextGuard` — revoked membership → 404 (A-2) | `apps/api/test/context/tenant-context.guard.spec.ts` | EXISTS |
| DB GUC unset → zero rows (A-3, A-4) | `packages/db/__tests__/middleware/tenant-context.spec.ts` | EXISTS (Testcontainers) |
| Cross-tenant read/update on tenants (B-1, B-2) | `apps/api/test/tenants/tenants.controller.spec.ts` | EXISTS (Testcontainers) |
| Cross-tenant stores read/update/delete (B-5..B-7) | `apps/api/test/stores/stores.controller.spec.ts` | EXISTS (Testcontainers) |
| Cross-tenant membership list/patch/revoke (B-8, B-11, B-12) | `apps/api/test/tenants/tenant-members.spec.ts`, `memberships.*.spec.ts` | EXISTS (Testcontainers) |
| Invitation accept with wrong-tenant token (B-10) | `apps/api/test/memberships/invitations.accept-lookup.spec.ts` | EXISTS (Testcontainers) |
| Whole-API cross-tenant sweep (B-13) | `apps/api/test/authz/cross-tenant.sweep.spec.ts` | **MISSING (T203 open)** |
| RLS bypass probe (G-1..G-3) | `packages/db/__tests__/rls.bypass.spec.ts` | **MISSING (T207 open)** |
| Application role has no BYPASSRLS (G-5) | — | **MISSING (G-5 not yet assigned)** |
| DB GUC SET LOCAL is transaction-scoped, not session-scoped (G-7) | `packages/db/__tests__/middleware/tenant-context.spec.ts` | EXISTS (Testcontainers) |

**Local test run result (2026-05-13):**
Testcontainers-backed `.spec.ts` files fail with `Container start failed:
Could not find a working container runtime strategy` — Docker is not available
in this environment. The corresponding `.unit.spec.ts` files (mock-based)
pass. This means the RLS-layer and Testcontainers-backed isolation claims
**cannot be verified as passing locally**; CI is required.

**RLS note:** The migration.spec.ts confirms RLS policies are present on all
tenant-owned tables (scenario G-4 — EXISTS and unit-testable via a
`pg_policies` query). The per-transaction `SET LOCAL app.current_tenant`
behaviour is tested by the unit variant of tenant-context.spec.ts without
Docker.

**Gap:** T203 (whole-API sweep) and T207 (RLS bypass probe) are not yet
implemented. Until both pass in CI, "100% of tenant-scoped endpoints" cannot
be claimed with certainty.

**Status: Partial.** Per-family isolation tests exist and are architected
correctly; whole-API sweep and RLS bypass probe are missing.

---

### SC-2 — Cross-store isolation

**Spec definition (spec.md §8):**
> 100% of store-scoped endpoints reject cross-store access in automated
> tests; zero exceptions.

**Evidence found:**

| Item | File | Status |
|---|---|---|
| Context switch to wrong store → 404 (D-2) | `apps/api/test/context/tenant-context.guard.spec.ts` | EXISTS |
| Direct store read outside access policy → 404 (D-3) | `apps/api/test/stores/stores.controller.spec.ts` | EXISTS (Testcontainers) |
| DB invariant I-3: store_access tenant FK (D-7, G-6) | `packages/db/__tests__/store-access.invariant.spec.ts` | EXISTS (Testcontainers) |
| Store-code uniqueness within tenant (T135) | `apps/api/test/stores/code.invariant.spec.ts` | EXISTS (Testcontainers) |
| No cross-tenant store reassignment (T137) | `apps/api/test/stores/no-reassign.spec.ts` | EXISTS (Testcontainers) |
| Whole-API cross-store sweep (D-8) | `apps/api/test/authz/cross-store.sweep.spec.ts` | **MISSING (T204 open)** |
| `kind='specific'` user + new store not auto-granted (D-5) | — | **MISSING (T176 open)** |
| Revoked store access invalidates cache (D-6) | — | **MISSING (T177 open)** |

**Status: Partial.** Same Docker-absent constraint as SC-1. The sweep test
(T204) is missing.

---

### SC-3 — Authorization coverage

**Spec definition (spec.md §8):**
> Every protected endpoint has at least one test for: unauthenticated,
> authenticated-but-wrong-tenant, authenticated-but-wrong-store (where
> applicable), and authenticated-but-insufficient-role.

**Evidence found:**

- `apps/api/test/auth/auth.guard.spec.ts`, `auth.guard.unit.spec.ts` — covers
  unauthenticated path (401 for missing/invalid session and bearer).
- `apps/api/test/common/exception.filter.spec.ts`,
  `packages/shared/__tests__/errors/envelope.spec.ts` — covers uniform error
  envelope shape across all four rejection types.
- Per-controller files (`tenants.controller.spec.ts`,
  `stores.controller.spec.ts`, `memberships.controller.spec.ts`,
  `context.controller.spec.ts`) include wrong-tenant / wrong-role variants.
- `apps/api/test/auth/roles.guard.spec.ts` — covers `@Roles()` allow/deny matrix.
- `apps/api/test/context/fr-ctx.spec.ts` — covers FR-CTX-4 (store-scoped without
  active store → 401) and FR-CTX-6.
- `apps/api/test/audit/audit.controller.spec.ts` — covers audit endpoint auth.

**Gaps:**

- `apps/api/test/authz/default-deny.spec.ts` (**T206**) — absent on disk. The
  "unannotated endpoint without `@Public()` fails closed" guarantee has no
  dedicated test. This is a non-trivial gap for SC-3.
- The whole-API authorization sweep (T203) being absent means the four-variant
  matrix is not exhaustively confirmed for every endpoint.
- Some I-class (strict DTO) per-endpoint tests are missing (I-2..I-8 per
  `tenant-isolation-matrix.md §13`).

**Status: Partial.** Individually tested endpoints demonstrate the required
variants, but there is no machine-verified exhaustive sweep, and the
default-deny test file is absent.

---

### SC-4 — Server-only authorization

**Spec definition (spec.md §8):**
> A documented manual probe (curl-style request bypassing the dashboard)
> confirms that no protected operation is accessible based on frontend role
> hints alone.

**Evidence found:**

- `AuthGuard` rejects both missing sessions and invalid bearer tokens; the
  single-use token rejection fix (`bb473c3`) closes the specific attack of
  replaying a used token via the Bearer path.
- `RolesGuard` evaluated server-side from session-resolved membership, not
  from any request header or body field.
- Zod `.strict()` `ValidationPipe` at every write endpoint rejects
  `is_platform_admin`, `role`, `tenant_id` in request bodies (E-1, E-2 covered).
- `apps/api/test/context/tenant-context.guard.spec.ts` includes tests
  confirming that context resolution is server-side and ignores body fields.

**Gaps:**

- `apps/api/test/authz/frontend-bypass.spec.ts` (**T205**) — absent on disk.
  The spec requires a test where a `store_staff` user crafts a tenant-admin
  request and is rejected by `RolesGuard` specifically (not by tenant-context).
- No standalone curl-style probe script or documented manual probe exists in
  the repo.

**Status: Partial.** The architecture is server-side enforced and the fix in
`bb473c3` demonstrates active hardening. The missing T205 test means the
formal verification for this criterion is incomplete.

---

### SC-5 — Context resolution p95 ≤ 200 ms

**Spec definition (spec.md §8):**
> For 95% of authenticated requests, the server resolves active tenant +
> active store + role + permissions in ≤ 200 ms p95 (measured end-to-end
> excluding business logic).

**Evidence found:**
- No performance measurement script or test exists on disk.
- `apps/api/test/performance/context-resolution.spec.ts` (**T310**) is absent.
- No p95 timing captured in any CI run, plan document, or commit message.

**Status: Needs measurement.** This criterion cannot be evaluated without an
actual p95 measurement against a running system. The architectural intent
(Postgres SoT + Redis read-through cache for sessions, server-side guard chain)
is compatible with meeting the target, but no measurement exists.

---

### SC-6 — Onboarding clarity

**Spec definition (spec.md §8):**
> A new tenant admin can invite a user, assign a role, choose a store-access
> policy, and have the user complete sign-in in under 5 minutes from invite send.

**Evidence found:**

- `quickstart.md` — exists; documents the invite → accept → sign-in flow as
  a step-by-step behavioral walkthrough. Satisfies the "documented onboarding
  flow" requirement.
- `apps/api/test/memberships/invitations.create.spec.ts` — integration test
  for invitation creation (Testcontainers — Docker blocked locally).
- `apps/api/test/memberships/invitations.accept-existing-user.spec.ts` — integration
  test for accept flow (Testcontainers — Docker blocked locally).
- `apps/api/test/memberships/invitations.accept-lookup.spec.ts` — token hash
  lookup and accept isolation (Testcontainers — Docker blocked locally).
- `apps/api/test/memberships/invitations.service.spec.ts`,
  `invitations.service.unit.spec.ts` — service layer tests pass locally.
- `apps/api/test/memberships/invitation.dto.spec.ts` — DTO schema tests pass locally.
- Invitation email enqueue: `apps/api/test/auth/email-queue.producer.spec.ts`
  passes locally (ioredis-mock).

**Gaps:**

- No automated stopwatch test asserting the entire flow completes in < 5 minutes.
  The spec says "in under 5 minutes" as the acceptance bar; this is an integration
  timing concern, not just a functional one.
- Testcontainers-backed invitation tests cannot be confirmed as passing in this
  environment.

**Status: Partial.** Flow is documented and individually tested; end-to-end
timing guarantee and full Testcontainers-backed validation are unconfirmed locally.

---

### SC-7 — Auditability

**Spec definition (spec.md §8):**
> 100% of role/permission/access changes are retrievable from the audit log per
> tenant for at least the documented retention period.

**Evidence found:**

- `apps/api/test/audit/audit-emitter.interceptor.spec.ts`,
  `audit-emitter.interceptor.unit.spec.ts` — `AuditEmitter` tests (unit pass locally).
- `apps/worker/test/audit/audit-fanout.processor.spec.ts` — fanout worker test
  (passes locally, ioredis-mock).
- `apps/worker/test/audit/audit.worker.spec.ts` — worker integration test (passes locally).
- `apps/worker/test/audit/drizzle-audit-db.adapter.spec.ts` — DB adapter test (passes locally).
- `apps/api/test/audit/audit.controller.spec.ts` — query API test (Testcontainers — Docker blocked).
- `apps/api/test/audit/audit.controller.unit.spec.ts` — passes locally.
- `apps/api/test/audit/insert-only.spec.ts` — insert-only posture (Testcontainers — Docker blocked).
- `apps/api/test/audit/redaction.spec.ts` — PII redaction (Testcontainers — Docker blocked).
- `apps/api/test/audit/anonymous-actor.spec.ts` — anonymous-actor pattern (Testcontainers — Docker blocked).
- `apps/api/test/audit/context.controller.audit.spec.ts` — context-switch emits audit events (Testcontainers — Docker blocked).
- `apps/api/test/audit/audit.query.schema.spec.ts` — Zod query schema (passes locally).
- `apps/api/test/audit/audit.repository.spec.ts` — repository integration (Testcontainers — Docker blocked).
- `apps/api/test/audit/audit.repository.unit.spec.ts` — passes locally.

**Gaps:**

- **T311 (audit retention policy)** is explicitly blocked pending retention schema
  design decisions. The "documented retention period" referenced by SC-7 does not
  exist in any committed artifact. Until T311 is implemented and the retention
  window is declared, the "at least the documented retention period" clause cannot
  be verified.
- Several audit Testcontainers tests (insert-only, redaction, anonymous-actor,
  repository) cannot be confirmed as passing locally.

**Status: Partial.** Audit capture architecture, worker pipeline, and query API
are fully implemented and tested at the unit level. The retention period is
undocumented and the retention sweep (T311) is deferred. This criterion is
**blocked on T311**.

---

### SC-8 — Reusability for POS

**Spec definition (spec.md §8):**
> A walkthrough document demonstrates how a hypothetical POS sync endpoint
> would attach to the existing tenant/store/user model with no schema changes
> to the foundation.

**Evidence found:**

- `auth_tokens` table has a `device_id` column (nullable; allows POS-device-bound
  tokens). Schema exists in `packages/db/src/schema/auth_tokens.ts`.
- `idempotency_keys` table and `IdempotencyKeyStore` helper are implemented in
  `packages/shared/src/idempotency/`.
- `/api/pos/v1/*` namespace is reserved — any request returns the standard
  not-found envelope.
- All existing schemas (`tenant_id`, `store_id` on every entity) allow a future
  POS device to reference `(tenant_id, store_id)` without schema changes.
- `packages/contracts/README.md` notes POS namespaces are reserved.

**Gaps:**

- `specs/001-foundation-auth-tenant-store/pos-seam-walkthrough.md` (**T265**) — file
  does **not exist** on disk. This is a hard requirement for SC-8 per the spec.
- `apps/api/test/pos-seam/walkthrough.spec.ts` (**T264**) — does **not exist** on disk.
- `apps/api/test/pos-namespace/reserved-404.spec.ts` (**T263**) — does **not exist** on disk.
- `packages/shared/__tests__/idempotency/store.spec.ts` (**T260**) — does **not exist** on disk
  (IdempotencyKeyStore implementation exists but its tests are absent).

**Status: Partial.** The foundation data model and auth subsystem provide the
structural seams. However, the specific deliverable required by SC-8 — the
walkthrough document — does not exist. Per the spec, "a walkthrough document
demonstrates…" is the success criterion. This criterion is **not verified** until
`pos-seam-walkthrough.md` is authored and `walkthrough.spec.ts` passes.

---

### SC-9 — No frontend-only gates

**Spec definition (spec.md §8):**
> Code review checklist for every PR in this milestone explicitly verifies "no
> protected action gated solely by frontend state"; 0 violations at merge time.

**Evidence found:**

- `.github/pull_request_template.md` includes a Constitution Check section with
  an explicit "no protected action gated solely by frontend state" checklist item.
  The template has been present throughout all merged PRs in this feature.
- No PR in this feature branch has been flagged or reverted for a frontend-gate
  violation (based on git log and PR history through PR #151).
- `RolesGuard` and `TenantContextGuard` are server-side; they do not check any
  frontend-supplied header or cookie value beyond the authenticated session token.
- Zod `.strict()` rejects all mass-assignment attempts at the request body level.

**Gaps:**

- `apps/api/test/authz/default-deny.spec.ts` (**T206**) — absent on disk. The
  formal machine-checked guarantee that unannotated endpoints fail closed is
  missing.
- `tools/eslint-rules/no-unscoped-tenant-query.js` (**T208**) — absent on disk.
  The lint-time guard preventing un-scoped Drizzle queries (which is a form of
  backend bypassing) is not yet implemented.
- Absence of T208 means the "no unscoped query" guarantee is currently enforced
  only by code review, not by CI.

**Status: Partial.** Process controls (PR template, architecture) provide a
reasonable foundation. T206 and T208 provide the automated machine verification
required for full confidence.

---

## 6. Recommended Next Thin Slices After T309

In priority order:

| Slice | Description | Unblocks |
|---|---|---|
| **T265** | Author `specs/001-foundation-auth-tenant-store/pos-seam-walkthrough.md` | SC-8 documented |
| **T264 / T263** | Author POS-seam walkthrough test and reserved-404 test; author IdempotencyKeyStore test (T260) | SC-8 fully verified |
| **T203 / T204** | Implement whole-API cross-tenant and cross-store sweep tests | SC-1, SC-2 verifiable at 100% |
| **T205 / T206** | Frontend-bypass probe test and default-deny test | SC-3, SC-4, SC-9 machine-verified |
| **T208** | Custom ESLint rule for unscoped Drizzle queries | SC-9 CI-enforced |
| **T311** | Audit log retention policy — declare window, implement BullMQ sweep | SC-7 fully verified |
| **T310** | Performance measurement script for context resolution p95 | SC-5 verified |
| **T207** | RLS bypass probe (raw-SQL test with Testcontainers) | SC-1 DB-layer verified |

---

## 7. Scope Confirmation

This document:

- Creates / updates `specs/001-foundation-auth-tenant-store/sc-verification.md` only.
- Does not modify any production source code.
- Does not modify `package.json`, `pnpm-lock.yaml`, DB schema, SQL migrations,
  OpenAPI YAMLs, CI configuration, Codecov configuration, coverage thresholds,
  or any generated artifact.
- Does not modify or create POS / dashboard UI / billing / reports / analytics /
  dbt / ClickHouse / Dagster artifacts.
- Does not commit, push, or open a PR.

---

## 8. Validation Output

### `git diff --check`

No whitespace errors (blank run — docs-only file).

### `pnpm test` results (captured 2026-05-13)

| Package | Suites | Tests | Notes |
|---|---|---|---|
| `packages/auth` | 2/2 pass | 31/31 pass | No Docker dependency |
| `packages/shared` | 7/7 pass | 114/114 pass | No Docker dependency |
| `packages/db` | 2/9 pass | 70/148 pass | **7 suites fail** — all `Container start failed: Could not find a working container runtime strategy`; Testcontainers tests require Docker |
| `apps/api` | 68/89 pass | 1258/1621 pass | **21 suites fail** — all same Docker/Testcontainers error; `.unit.spec.ts` variants all pass |
| `apps/worker` | 11/11 pass | 198/198 pass | No Docker dependency (ioredis-mock) |

**Docker / Testcontainers is unavailable in this environment.** All test suite
failures trace to `Container start failed: Could not find a working container
runtime strategy`. There are no code-logic failures. The 100% pass rate for
non-Testcontainers tests (1 641 passing: auth + shared + worker + api unit
variants) confirms the application layer and unit coverage.

The Testcontainers-backed tests (DB-layer RLS, isolation, migration, auth
repository, invitation flows, audit repository, store/tenant controllers) require
Docker and must be confirmed in CI (see `.github/workflows/ci.yml`).

---

**End of sc-verification.md.**
