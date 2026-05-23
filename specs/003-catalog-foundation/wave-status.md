# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-22 (post-#285 closeout — T342, T343, T344 isolation specs merged)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `fd18598` (PR #285, 2026-05-22)
**Active findings:** 3 — `MISSING_WITHSTORE_HELPER` (low; scaffold mismatch), `RLS_STORE_ABSENT_READ_LEAK` (medium; matrix §4.6/§7.6 fail-closed not delivered), `RLS_UNSET_TENANT_GUC_CAST_ERROR` (medium; matrix §2.3/§3.3/§5.3/§6.5/§7.6 fail-closed not delivered)
**Resolved findings (kept for audit):** 2 — `RLS_CROSS_STORE_READ_LEAK` (resolved PR #254 @ `483aae4`), `HARNESS_SEED_BUGS` (resolved PR #279 @ `e33fd0e`)

---

## TL;DR

T342, T343, T344 merged in PR #285 @ `fd18598` (2026-05-22). All three isolation
specs are on `main`. T344 is **fully GREEN**. T342 and T343 each carry `it.todo`
deferred coverage against the two active findings (`RLS_STORE_ABSENT_READ_LEAK` and
`RLS_UNSET_TENANT_GUC_CAST_ERROR`). T336 remains blocked on `MISSING_WITHSTORE_HELPER`.
No slice is `local_uncommitted`.

---

## Merged on `main`

| Slice ID | Subject | Reference |
|---|---|---|
| `T320` | Catalog schema modules (`packages/db/src/schema/catalog/`) | merged |
| `T331` | Schema-shape tests for 7 catalog tables | merged |
| `T326_T327_T328_T329` | RED tests for the 0007 migration (up, down, round-trip, RLS sweep) | merged |
| `T330` | `0007_catalog.sql` + `0007_catalog.down.sql` | merged |
| `PR250_DB_INTEGRATION_FALLOUT` | CodeRabbit fixes for `0001-catalog.spec.ts` + `outbox/rls.spec.ts` | PR #250 |
| `RLS_CROSS_STORE_RED_PROOF` | RED proof spec for the cross-store leak | merged in PR #254 @ `483aae4` |
| `RLS_CROSS_STORE_FIX` | `0008_catalog_store_read_isolation.sql` + `.down.sql` | PR #254 @ `483aae4` |
| `T335_TENANT_HELPER_COVERAGE` | `withTenant` catalog coverage spec for `tenant_products` via `runWithTenantContext` | PR #260 @ `5801369` |
| `T340` | Catalog isolation harness (`apps/api/test/catalog/__support__/isolation-harness.ts`) | PR #264 @ `02cdf75` |
| `T341` | Cross-tenant read isolation (`apps/api/test/catalog/isolation/cross-tenant-read.spec.ts`) — 31 assertions, Groups A–D | PR #268 @ `263492a` |
| `HARNESS_FIX` | Fix three seed constraint violations in `isolation-harness.ts`; T341 store GUC assertions corrected | PR #279 @ `e33fd0e` |
| `0009_STORE_GUC_FIX` | `0009_catalog_store_empty_guc_fix.sql` — CASE guard for empty `app.current_store` cast on 3 RLS policies | PR #279 @ `e33fd0e` |
| `T342` | Cross-store read sweep (`apps/api/test/catalog/isolation/cross-store-read.spec.ts`) — §4.6/§7.6 store-absent deferred as `it.todo` (RLS_STORE_ABSENT_READ_LEAK) | PR #285 @ `fd18598` |
| `T343` | RLS bypass probe (`apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts`) — 9 `it.todo` deferred against RLS_STORE_ABSENT_READ_LEAK + RLS_UNSET_TENANT_GUC_CAST_ERROR | PR #285 @ `fd18598` |
| `T344` | Malicious body-override sweep (`apps/api/test/catalog/isolation/malicious-override.spec.ts`) — GREEN, no deferred coverage | PR #285 @ `fd18598` |

### Context from neighboring merges

These landed alongside the catalog work and affect the surrounding context, not catalog directly:

- **PR #256** (`docs(agent-os): add spec execution layer`) — Agent OS v1 docs landed at `a482842`. The map you're reading now is governed by `docs/agent-os/slice-schema.yaml`.
- **PR #257** (`ci: remove Codecov coverage upload step`) — landed at `1bd5161`. The recurring `db-integration` Codecov `AggregateError` false-FAILURE is gone from CI; future PRs will not show that flake.
- **PR #258** (`docs(catalog): refresh Agent OS execution map`) — landed at `470da55`. First spec-level map refresh under the Agent OS protocol.
- **PR #261** (`docs(agent-os): add post-merge closeout protocol`) — landed at `4840e70`. Defines the workflow used to author *this* refresh. Schema now formalizes the audit fields (`merged_in_pr`, `merged_at_commit`, `merged_at_date`, `previously_blocked`, plus their finding-level counterparts).
- **PR #255** (T565 worker outbox redaction it.todo gaps) — landed at `c182a27`. Worker-side, no catalog impact.
- **PR #259** (T595 PR-B-2 outbox_pending_total gauge) — landed at `7e9c031`. Worker-side, no catalog impact.

---

## Local only — committed/uncommitted, not on `main`

_None._

All previously-local work is now on `main`:
- `T341` — merged in PR #268 @ `263492a` (2026-05-21)
- `T340` — merged in PR #264 @ `02cdf75` (2026-05-21)
- `T335_TENANT_HELPER_COVERAGE` — merged in PR #260 @ `5801369`
- `RLS_CROSS_STORE_RED_PROOF`, `RLS_CROSS_STORE_FIX` — merged in PR #254 @ `483aae4`

---

## Resolved findings (audit trail)

### `HARNESS_SEED_BUGS` — RESOLVED

- **Resolved by:** `HARNESS_FIX` (PR #279 @ `e33fd0e`, merged 2026-05-22)
- **Originally affected:** `apps/api/test/catalog/__support__/isolation-harness.ts`
- **Mechanism of fix:** (1) Added `created_by` to `product_aliases` INSERT column list. (2) Changed `product_aliases` store-scoped rows from `identifier_type = 'external_pos_id'` to `'sku'` with `source_system = null` to satisfy the `product_aliases_store_scope_consistency` CHECK. (3) Renamed `created_by` → `changed_by` and added `correlation_id` to `price_history` INSERT. PR #279 also fixed `cross-tenant-read.spec.ts` to explicitly set `app.current_store = ''` on four tenant-owner count assertions (resolves `T341_MISSING_STORE_GUC`), bringing T341 from 29 to 31 assertions.
- **Verification:** T341 GREEN 31/31 on Testcontainers (WSL Docker) after PR #279 merge.
- **Audit kept because:** HARNESS_SEED_BUGS unblocked T342–T344 dispatch; the chain of proof is valuable context for future harness modifications.

### `RLS_CROSS_STORE_READ_LEAK` — RESOLVED

- **Resolved by:** `RLS_CROSS_STORE_FIX` (PR #254 @ `483aae4`, merged 2026-05-21)
- **Originally affected:** `store_product_overrides`, `unknown_items` (read path only)
- **Mechanism of fix:** dropped the two split PERMISSIVE SELECT policies per table and replaced them with one combined policy that AND-gates `tenant_id` and `(store_id OR app.current_store = '')`. Preserves the tenant-owner empty-string carve-out documented in `rls-test-matrix.md §4.3`.
- **Verification:** RED proof `catalog-rls-store-read.spec.ts` flipped from 2/2 RED to 2/2 GREEN. Regression sweep on `migration/0001-catalog`, `outbox/rls`, and `schema/catalog` all stayed green.
- **Audit kept because:** the spec's `rls-test-matrix.md` cites this resolution as the model for future split-permissive bugs; deleting the finding would erase that pointer.

---

## Active findings

### `RLS_STORE_ABSENT_READ_LEAK` — discovered 2026-05-22

- **Summary:** Matrix §4.6 and §7.6 prescribe "tenant set, `app.current_store` GUC absent (never set in session) → 0 rows" for `store_product_overrides` and `unknown_items`. CI on PR #285 (commit `30751989`) showed the contract is not delivered: PG returns `''` (empty string) — not NULL — from `current_setting('app.current_store', true)` when the GUC has never been set, and the 0009 CASE guard's `WHEN '' THEN TRUE` carve-out branch fires, returning all tenant rows instead of 0. Same family as the resolved `RLS_CROSS_STORE_READ_LEAK` but on the "store absent" axis.
- **Severity:** medium (data-visibility issue on read path; same tier as the resolved cross-store leak).
- **Proof:** CI failure (PR #285 @ `30751989`) — six test cases failing with "Expected '0', Received '2'" or `''::uuid` cast error. Independent PG 16 probe (2026-05-22) confirmed `current_setting('app.current_store', true)` returns `''` not NULL.
- **Blocks:** No slice-level dispatch blocker. PR #285 ships T342 and T343 with §4.6 / §7.6 store-absent coverage deferred as `it.todo` placeholders. Full §4.6 / §7.6 GREEN waits on a future SQL slice.
- **Resolution paths (either, with explicit user approval):**
  1. New gated SQL slice (e.g. `0010_*`) extending 0009's CASE guard to distinguish "GUC explicitly empty (carve-out)" from "GUC never set (fail-closed)" — e.g. by keying the carve-out on a dedicated `app.current_store_owner_carveout` sentinel rather than the empty string.
  2. Matrix amendment re-specifying §4.6 / §7.6 to require an explicit `DISCARD ALL` (or equivalent connection-reset) before the contract holds — i.e. accepting that the never-set behavior is "indistinguishable from explicit-empty" at the policy layer and revising the contract accordingly.

### `RLS_UNSET_TENANT_GUC_CAST_ERROR` — discovered 2026-05-22

- **Summary:** Matrix §2.3, §3.3, §5.3, §6.5, §7.6 prescribe "`app.current_tenant` unset / NULL → 0 rows" for every tenant-scoped catalog table. CI on PR #285 (commit `30751989`) showed five SELECT cases throwing `invalid input syntax for type uuid: ""` (SQLSTATE 22P02) instead of returning 0 rows. The matrix author assumed NULL semantics (`NULL::uuid = NULL`, policy `tenant_id = NULL` evaluates to NULL → 0 rows); PG actually returns `''` from `current_setting('app.current_tenant', true)` for a never-set GUC, and `''::uuid` raises before the policy evaluates. The §2.3 `tenant_products` case in the bypass-probe spec passed via a cold no-GUC pool path; the other four (§3.3, §5.3, §6.5, §7.6) failed because they share `withRawClient` against `env.app` where pool-scoped `set_config` bleed exposes the cast error.
- **Severity:** medium (read-path fail-closed semantics defect; write-path RLS still enforces).
- **Proof:** CI failure (PR #285 @ `30751989`) — five "unset tenant GUC: SELECT returns 0 rows" cases failing with `22P02`. PG 16 probe (2026-05-22) confirmed `current_setting('app.current_tenant', true)` returns `''` (not NULL) for a never-set GUC.
- **Blocks:** No slice-level dispatch blocker. PR #285 ships T343 with five `it.todo` placeholders covering the deferred contract.
- **Resolution paths (either, with explicit user approval):**
  1. New gated SQL slice (e.g. `0010_*`) adding a CASE guard around the tenant cast in every tenant-scoped policy, analogous to 0009's store-GUC guard. Body shape: `tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL ELSE current_setting('app.current_tenant', true)::uuid END` — preserves fail-closed (NULL comparison returns no rows) without throwing.
  2. Matrix amendment redefining §2.3 / §3.3 / §5.3 / §6.5 / §7.6 expected result from "0 rows" to "SQLSTATE 22P02 cast error" — arguably stronger fail-closed semantics (loud failure beats silent leak), but requires coordinated test updates to assert the error code rather than row count.

### `MISSING_WITHSTORE_HELPER`

- **Summary:** `rls-test-matrix.md:464-465` and `plan.md:210` claim `packages/db/src/helpers/with-store.ts` ships from feature 001, but the file does not exist on `main`. Only `with-tenant.ts` and `audit-insert.ts` are present.
- **Severity:** low (documentation / scaffolding mismatch — not a security defect or correctness bug; it's a spec-vs-reality drift that blocks one test slice).
- **Proof:** `ls packages/db/src/helpers/` on `main @ 5801369` returns only `audit-insert.ts` and `with-tenant.ts`.
- **Blocks:** `T336` only.
- **Resolution paths (either, with explicit user approval):**
  1. **New gated slice** authors `packages/db/src/helpers/with-store.ts` (forbidden surface — needs approval).
  2. **Reinterpret T336** to test the store GUC contract via `runWithTenantContext` + manual `SET LOCAL app.current_store`, treating "the helper's contract" rather than "the helper's TS surface" as the unit under test. This is the same shape the local `T335_TENANT_HELPER_COVERAGE` spec uses for the tenant side.

---

## Blocked

| Slice ID | Blocked by | Notes |
|---|---|---|
| `T336` | `MISSING_WITHSTORE_HELPER` finding | No remaining slice-level deps — `RLS_CROSS_STORE_FIX` cleared. Only the missing helper file blocks now. |

---

## Ready / in-flight

_None._ T342, T343, and T344 merged in PR #285 @ `fd18598` (2026-05-22). No slices are currently in-flight.

---

## Proposed (awaiting approval)

`PHASE3_RED_WAVE` — four RED test slices that can run in parallel because
their `allowed_files` touch disjoint paths under `apps/api/test/catalog/**`
(T340 removed — merged via PR #264):

- `T350_TENANT_CATALOG_CREATE_RED`
- `T360_GLOBAL_CATALOG_LIST_RED`
- `T372_STORE_OVERRIDE_CREATE_RED`
- `T383_PRODUCT_ALIASES_UNIQUENESS_RED`

Eligibility gates are **satisfied** (RLS fix merged; T340 and T341 merged; CI on
`main` green). Still `proposed: true` because parallel dispatch needs explicit
user endorsement.

---

## Next recommended action

**Resolve the two active medium-severity findings** (`RLS_STORE_ABSENT_READ_LEAK` and
`RLS_UNSET_TENANT_GUC_CAST_ERROR`) or accept option (b) (matrix amendment) for each.
The recommended path for both is a single gated SQL slice `0010_*` adding CASE guards
for the unset GUC paths to both the store-scoped and tenant-scoped RLS policies — this
unblocks the deferred `it.todo` coverage in T342 and T343. Alternatively, endorse the
Phase-3 RED wave (`PHASE3_RED_WAVE`) to advance catalog feature implementation.
T336 is independent and still needs an explicit decision on `MISSING_WITHSTORE_HELPER`.

---

## Post-merge closeout

When a PR for one of this spec's slices merges to `main`, run the
closeout to refresh both this file and `execution-map.yaml`.
Full workflow: `docs/agent-os/maestro-playbook.md` "Workflow —
post-merge closeout".
Reusable prompt template: `docs/agent-os/templates/post-merge-closeout-prompt.md`.

Short prompt:

```text
Use Agent OS.
Close out PR #<PR_NUMBER>.
Spec: specs/003-catalog-foundation
Expected slice: <EXPECTED_SLICE_ID>
Update execution-map.yaml and wave-status.md.
Stop before commit.
```

The closeout updates these audit fields on the merged slice:
`merged_in_pr`, `merged_at_commit`, `merged_at_date`, `previously_blocked`.
If the slice resolves a finding, the same closeout sets
`resolved_by_pr`, `resolved_by_commit`, `resolved_at`, and
`previously_blocked` on the finding entry.

---

## Next short Maestro prompt

Resolve the store-absent and unset-tenant GUC findings with a new SQL migration slice:

```text
Use Agent OS. Execute slice 0010_RLS_GUC_CAST_FIX. Stop before commit.
```

Or endorse the Phase-3 RED wave to advance catalog feature implementation:

```text
Use Agent OS. Schedule group PHASE3_RED_WAVE. Stop before dispatch.
```

For T336 — only run this once you've authorized a resolution path for `MISSING_WITHSTORE_HELPER`:

```text
Use Agent OS. Resolve finding MISSING_WITHSTORE_HELPER. Stop before commit.
```
