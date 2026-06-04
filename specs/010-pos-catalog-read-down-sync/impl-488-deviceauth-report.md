# Implementation Report — Issue #488: Read-Down Device-Principal Auth (Option B-prime)

**Repo:** `ahmed-shaaban-94/Data-Pulse-2`
**Issue:** [#488](https://github.com/ahmed-shaaban-94/Data-Pulse-2/issues/488)
**Direction approved by owner:** Option B-prime (authenticate the `devices` pairing token directly) + the
`[GATED]` allow for the read-down OpenAPI security scheme + implement in an isolated worktree.
**Status:** ⏸️ **IMPLEMENTED — STOPPED BEFORE COMMIT** (authorization was implement-in-worktree, not commit/push/PR).
**Worktree / branch:** `.claude/worktrees/488-preflight` on `preflight/488-readdown-deviceauth` (off `origin/main` @ `4012439`). The in-flight `feat/013-crud-impl` work is untouched.

---

## 1. What was built (Option B-prime)

A new read-down-only device-principal guard authenticates the POS terminal by its **`devices` pairing
token alone** — no operator session — resolving `(tenant_id, store_id)` from the store-bound device row.

| File | Change |
|:--|:--|
| `apps/api/src/auth/pos-device-auth.guard.ts` | **NEW.** Reads `Authorization: Bearer <device_token>`, resolves via the shipped `DeviceRepository.findActiveByAttestation`, publishes `req.context` (tenant/store from the device row) **and** `req.principal` (device principal: `userId:null`, `tokenId:device.id`, `scope:"pos"`) for the audit actor. Non-disclosing 401 on missing/malformed/unknown/revoked/non-device credential. Does NOT extend or broaden `PosOperatorAuthGuard`. |
| `apps/api/src/catalog/read-down/read-down.controller.ts` | Swapped `@UseGuards(PosOperatorAuthGuard, TenantContextGuard)` → `@UseGuards(PosDeviceAuthGuard)` on **both** read-down routes only. Controller's `store_context_required` + non-disclosing `branch_id`-mismatch logic is UNCHANGED. |
| `apps/api/src/catalog/read-down/read-down.module.ts` | Provide `DeviceRepository` (`new DeviceRepository(pool)`, `inject:[PG_POOL]` — **identical** to `PosOperatorsModule`) + `PosDeviceAuthGuard`. |
| `packages/contracts/openapi/catalog/read-down.yaml` | **[GATED — granted].** Kept the `clerkJwt` scheme KEY (see §4), **dropped `bearerFormat: JWT`** (the credential is an opaque device token, not a JWT), and rewrote the description to the accurate device-principal contract: device pairing token in `Authorization: Bearer`, no operator JWT, no `X-Terminal-Token`. |
| `apps/api/test/auth/pos-device-auth.guard.unit.spec.ts` | **NEW.** 5 unit cases (valid→context+principal; missing/malformed/unknown-or-revoked/cookie → 401). |
| `apps/api/test/catalog/read-down/isolation/device-principal-auth.spec.ts` | **NEW.** Real-guard integration spec (seeds a `devices` row, presents a real Bearer token). **See §3 — could NOT run locally.** |
| `apps/api/test/catalog/read-down/snapshot/__snapshot-harness.ts` | Fixed: override the guard the routes NOW use (`PosDeviceAuthGuard`) instead of the stale `PosOperatorAuthGuard`/`TenantContextGuard` — **without this the whole read-down integration suite would break at bootstrap in CI.** |

---

## 2. Test results — what ACTUALLY ran vs what is CI-only

> **Read this split carefully — three suites "passed" by SKIPPING (Docker unavailable in this environment).**

**Executed locally and genuinely GREEN (no Docker needed):**
- `pos-device-auth.guard.unit.spec.ts` — **5/5 pass.** Full guard contract incl. the `req.principal` audit-actor assertion. **This is the real proof of the guard's logic.**
- `read-down.contract.spec.ts` — **24/24 pass.** Confirms the GATED YAML edit keeps conformance green (the spec asserts the `clerkJwt` key is defined + referenced; it does NOT assert `description`/`bearerFormat`, so the edit is conformance-safe).
- `toBody.unit.spec.ts` — pass (unchanged).
- `tsconfig.build.json` (src-only typecheck) — **exit 0, zero errors.** My `src/` wiring compiles clean.

**SKIPPED locally (Docker/Testcontainers unavailable) — CI-validated, NOT executed here:**
- `device-principal-auth.spec.ts` (NEW, the end-to-end device-auth proof) — **never executed.** See §3.
- `device-auth-required.spec.ts`, `snapshot.spec.ts` — skipped via `MIGRATION_TEST_ALLOW_SKIP=1`.

The combined run reported "6 suites / 61 passed," but **61 counts skipped specs as passed.** What was genuinely
exercised is the guard unit test + contract conformance + toBody + src typecheck. **Do not read the
integration layer as validated** — its first real execution is CI.

**Pre-existing (NOT introduced here):** two test-type-drift errors under the loose `tsconfig.json`
(`__snapshot-harness.ts:155` supertest `TestAgent`/`SuperTest`, `snapshot.spec.ts:118`) exist verbatim on
`origin/main` (the `http: () => request(app…)` line + a `:118` cast I never touched). All of MY new/changed
files are typecheck-clean.

---

## 3. ⚠ The load-bearing unrun test has an RLS/pool risk — flag prominently

`device-principal-auth.spec.ts` is **first-of-kind**: no existing test exercises a real `devices` lookup
through the RLS-enforced app pool against a seeded row (`pos-operators.service.spec.ts` **mocks**
`DeviceRepository`). **CI is its first real execution.**

The specific exposure: the test seeds the `devices` row via `env.admin` but looks it up via `DeviceRepository`
on `PG_POOL` (= `env.app`). The `devices` RLS policy (`0001_pos_operator_identity.sql`) is
`ENABLE … FORCE ROW LEVEL SECURITY` with:
```
USING ( tenant_id = current_setting('app.current_tenant', true)::uuid
        OR current_setting('app.is_platform_admin', true) = 'true' )
```
`findActiveByAttestation` sets **no GUC** (by design — the device is the source of context). So **if CI's
`env.app` is the FORCE-RLS role, the test's no-GUC lookup could return zero rows and the test would fail** —
needing the lookup on `env.admin`, or a platform-admin GUC wrapper, in a test-setup follow-up.

**Crucial distinction (keeps the report honest both ways):**
- **PRODUCTION read-down auth is SOUND** and mirrors a *proven, shipped* path: `PosOperatorsModule` resolves
  the device via the **identical** `PG_POOL` + `findActiveByAttestation` (no GUC) wiring that operator
  sign-in uses and ships working. My `ReadDownModule` wiring is line-for-line the same. So any failure of the
  unrun test is a **test-setup risk (seed/pool choice in CI)**, NOT a production-auth defect.
- The unrun test simply hasn't *confirmed* its own seeding mirrors that proven path. First green is CI.

---

## 4. Reconciliation — kept the `clerkJwt` scheme KEY (this reverses my own preflight; flagged)

My preflight said "align the YAML *away from* `clerkJwt`." On implementation I kept the key. Why this is
correct, recorded so the artifacts don't contradict:
- `clerkJwt` is the **shared POS-bearer scheme KEY convention** across every POS contract — verified:
  `pos-sales/sales.yaml`, `pos-audit-events`, `pos-operators`, `unknown-items`, and read-down all key it
  `clerkJwt`, each in its own file.
- The backend already **rejected** the alternative name: per `CLAUDE.md`, the README's `posDeviceAuth` was a
  *mislabel*. Re-introducing it would override a settled backend decision from inside a #488 follow-up.
- Renaming the scheme key POS-wide is a **cross-contract convention decision (owner/backend's call)**, outside
  #488's scope and outside the granted GATED allow (which was to make read-down's scheme *accurate*, not to
  rename the POS-wide convention).
- So the disciplined fix is **semantic accuracy under the existing key**: dropped the false `bearerFormat: JWT`
  and rewrote the description to state device-pairing-token / no-JWT / no-`X-Terminal-Token`. A full key rename
  is **deferred to the owner** as a separate decision.

---

## 5. Regression fixed mid-build (would have broken CI silently)

Swapping the guard left `request.principal` unset, and the global `AuditEmitterInterceptor`
(`audit-emitter.interceptor.ts:105-106`) reads `request.principal?.userId` for the FR-080 read-access audit
actor. The guard now publishes a device principal so the audit actor is faithful: **null operator user** (a
person did not act — the terminal did) + the device's tenant/store. Unit-covered (PDG1 asserts `req.principal`).
Also fixed the snapshot harness guard-override (§1) — without it the resolver suites break at Nest bootstrap in
CI because the route's `PosDeviceAuthGuard` would be neither provided nor overridden.

---

## 6. Forbidden-path audit (clean)

`git status --porcelain` in the worktree — 8 entries, all intended:
- 3 NEW (`pos-device-auth.guard.ts` + 2 specs), 1 NEW doc (this + preflight), 3 MODIFIED (controller, module, harness).
- **GATED surfaces touched: ONLY `packages/contracts/openapi/catalog/read-down.yaml`** — the granted allow.
- **NO** `package.json` / `pnpm-lock.yaml` / SQL migration (`packages/db/drizzle/**`) / `.github/**` touched.
- No `dist/`/`node_modules` staged (build artifacts gitignored; built only to run tests).

---

## 7. Deployment confirmation plan (D-DEPLOY) — for after merge

1. Re-pin the catalogue OpenAPI; confirm the device-principal scheme (no `bearerFormat: JWT`) is the deployed
   shape; bump the contract `version` if the convention requires it.
2. CI smoke (Docker present): the new `device-principal-auth.spec.ts` runs for real — **watch for the §3 RLS
   risk on first run**; if it fails on the seed/pool, switch the lookup to `env.admin` or wrap in a
   platform-admin GUC (test-only).
3. Notify POS-Pulse 010 to re-pin `src/shared/api-types.ts` and lift its §A6/§A2 holds.

---

## 8. Stopped before commit

Per the authorization (implement-in-worktree) and `docs/agent-os/standing-rules.md` (stop-before-commit is the
default), **nothing committed / pushed / PR'd.** The work is durable in the worktree on
`preflight/488-readdown-deviceauth`. Awaiting explicit go-ahead to commit + open a PR (which would itself need
the GATED `read-down.yaml` change called out for review).

**Verified locally:** guard unit test (5/5), contract conformance (24/24), src typecheck (clean),
forbidden-path audit (clean). **NOT verified locally (Docker-skipped, CI-first):** the real-guard integration
spec — see §3. Implementation mirrors a proven production path; the unrun test is a test-setup risk, not a
production-auth risk.
