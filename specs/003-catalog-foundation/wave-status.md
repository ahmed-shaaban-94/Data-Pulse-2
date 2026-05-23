# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-23 (0011_CATALOG_STORE_CARVEOUT_SENTINEL merged — PR #295 @ `2f7554d`)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `2f7554d` (PR #295, 2026-05-23)
**Active findings:** 1 — `MISSING_WITHSTORE_HELPER` (low; scaffold mismatch)
**Resolved findings (kept for audit):** 4 — `RLS_CROSS_STORE_READ_LEAK` (resolved PR #254 @ `483aae4`), `HARNESS_SEED_BUGS` (resolved PR #279 @ `e33fd0e`), `RLS_UNSET_TENANT_GUC_CAST_ERROR` (resolved PR #292 @ `6adf6df`), `RLS_STORE_ABSENT_READ_LEAK` (resolved PR #295 @ `2f7554d`)

---

## TL;DR

Slice `0011_CATALOG_STORE_CARVEOUT_SENTINEL` **merged** in PR #295 @ `2f7554d`
(2026-05-23). Resolves finding `RLS_STORE_ABSENT_READ_LEAK`. Introduces sentinel `'*'`
to distinguish tenant-owner cross-store carve-out (→ `TRUE` on SELECT) from never-set
GUC (→ `FALSE`, fail-closed). The 8 deferred `it.todo` items in T342/T343 (4 in
`cross-store-read.spec.ts` §4.6/§7.6, 4 in `rls-bypass-probe.spec.ts` §4.6/§7.6 +
no-GUC pool) are now executable assertions. CodeRabbit security fix: the write policy
USING clause uses `WHEN '*' THEN FALSE` to block cross-store DELETE via the FOR ALL
policy. Down migration restores exact 0010-form bodies.

Only remaining active finding: `MISSING_WITHSTORE_HELPER` (low severity).
T336 remains blocked on that finding.

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
| `0010_CATALOG_TENANT_GUC_CAST_FIX` | `0010_catalog_tenant_empty_guc_fix.sql` — CASE guard for empty `app.current_tenant` cast across 13 policies on 5 tables; 5 T343 `it.todo` unblocked | PR #292 @ `6adf6df` |
| `0011_CATALOG_STORE_CARVEOUT_SENTINEL` | `0011_catalog_store_carveout_sentinel.sql` — sentinel `'*'` for store carve-out; three-way CASE guard on 3 RLS policies; 8 `it.todo` items converted; write-denial regression tests added | PR #295 @ `2f7554d` |

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

### `RLS_UNSET_TENANT_GUC_CAST_ERROR` — RESOLVED

- **Resolved by:** `0010_CATALOG_TENANT_GUC_CAST_FIX` (PR #292 @ `6adf6df`, merged 2026-05-23)
- **Originally affected:** `tenant_products`, `tenant_product_categories`, `product_aliases`, `price_history`, `unknown_items` — read-path cast error on unset tenant GUC.
- **Mechanism of fix:** Added a `CASE` guard to 13 policy bodies across 5 tables so that `current_setting('app.current_tenant', true) = ''` maps to `NULL` rather than raising `22P02`. Group A: 0007-form INSERT/UPDATE policies on 5 tables. Group B: 0009-form SELECT/write policies on `store_product_overrides` and `unknown_items` (store CASE guard preserved; tenant guard added). Down migration restores the 0007 body for Group A and the 0009 body for Group B.
- **Verification:** T343 rls-bypass-probe 35 passed / 4 todo (5 formerly-todo tenant-axis assertions now execute); T341 31/31 regression GREEN; T342 17 passed / 4 todo (store-axis unchanged); migration round-trip 27/27; CLI spec 10/10.
- **Audit kept because:** documents the `''` vs NULL GUC semantics gotcha and the CASE-guard pattern used — valuable context for any future policy author.

### `RLS_STORE_ABSENT_READ_LEAK` — RESOLVED

- **Resolved by:** `0011_CATALOG_STORE_CARVEOUT_SENTINEL` (PR #295 @ `2f7554d`, merged 2026-05-23)
- **Originally affected:** `store_product_overrides` (§4.6), `unknown_items` (§7.6) — read path returned all-tenant rows when `app.current_store` GUC was never set, because `current_setting('app.current_store', true)` returns `''` (not NULL) for a never-set GUC, which matched the 0009 `WHEN '' THEN TRUE` carve-out.
- **Mechanism of fix:** Introduced sentinel value `'*'`. Tenant-owner cross-store code paths now call `set_config('app.current_store', '*', true)`. The three store-axis CASE guards are three-way: `WHEN '*' THEN TRUE/FALSE` (carve-out), `WHEN '' THEN FALSE` (fail-closed for never-set), `ELSE store_id = ...::uuid`. The write policy (FOR ALL) uses `WHEN '*' THEN FALSE` in USING to block cross-store DELETE — cross-store reads go through the SELECT-only policy. 8 call sites in the test suite updated from `''` to `'*'`.
- **Verification:** 8 previously-`it.todo` assertions in T342/T343 are now executable. CI on PR #295 passed.
- **Audit kept because:** documents the `''` vs "never set" GUC ambiguity and the sentinel pattern — valuable context for any future policy author or caller setting `app.current_store`.

### `RLS_CROSS_STORE_READ_LEAK` — RESOLVED

- **Resolved by:** `RLS_CROSS_STORE_FIX` (PR #254 @ `483aae4`, merged 2026-05-21)
- **Originally affected:** `store_product_overrides`, `unknown_items` (read path only)
- **Mechanism of fix:** dropped the two split PERMISSIVE SELECT policies per table and replaced them with one combined policy that AND-gates `tenant_id` and `(store_id OR app.current_store = '')`. Preserves the tenant-owner empty-string carve-out documented in `rls-test-matrix.md §4.3`.
- **Verification:** RED proof `catalog-rls-store-read.spec.ts` flipped from 2/2 RED to 2/2 GREEN. Regression sweep on `migration/0001-catalog`, `outbox/rls`, and `schema/catalog` all stayed green.
- **Audit kept because:** the spec's `rls-test-matrix.md` cites this resolution as the model for future split-permissive bugs; deleting the finding would erase that pointer.

---

## Active findings

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

_None — no slices are currently in-progress or locally-committed._

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

**No medium-severity findings remain.** The only active finding is `MISSING_WITHSTORE_HELPER`
(low severity; blocks `T336` only). Both RLS-axis findings are resolved:
`RLS_STORE_ABSENT_READ_LEAK` (PR #295) and `RLS_UNSET_TENANT_GUC_CAST_ERROR` (PR #292).

**Recommended next step:** Endorse the `PHASE3_RED_WAVE` to advance catalog feature
implementation. All four proposed RED test slices have satisfied eligibility gates.

`T336` is independent and still needs an explicit decision on `MISSING_WITHSTORE_HELPER`
before it can run.

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

Endorse the Phase-3 RED wave to advance catalog feature implementation:

```text
Use Agent OS. Schedule group PHASE3_RED_WAVE. Stop before dispatch.
```

For T336 — only run this once you've authorized a resolution path for `MISSING_WITHSTORE_HELPER`:

```text
Use Agent OS. Resolve finding MISSING_WITHSTORE_HELPER. Stop before commit.
```
