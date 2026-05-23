# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-24 (T336 reinterpreted to resolve `MISSING_WITHSTORE_HELPER` via path (b); slice authored on `test/003-t336-store-guc-coverage`, awaiting commit/merge)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `bbb9beb` (PR #309 docs closeout, 2026-05-23)
**Active findings:** 0
**Resolved findings (kept for audit):** 5 — `RLS_CROSS_STORE_READ_LEAK` (resolved PR #254 @ `483aae4`), `HARNESS_SEED_BUGS` (resolved PR #279 @ `e33fd0e`), `RLS_UNSET_TENANT_GUC_CAST_ERROR` (resolved PR #292 @ `6adf6df`), `RLS_STORE_ABSENT_READ_LEAK` (resolved PR #295 @ `2f7554d`), **`MISSING_WITHSTORE_HELPER`** (resolved by T336 reinterpretation — PR/commit set on closeout)

---

## TL;DR

**PHASE3_RED_WAVE complete.** All four catalog service-layer RED+GREEN pairs landed on
`main` 2026-05-23 in independent squash PRs (each pair shipped together; the original
plan was RED-first then GREEN-later, but the slice owners paired them in-branch):

- **PR #300** @ `2bf7e27` — `TenantCatalogService.create` (T350 RED + T351 GREEN)
- **PR #301** @ `f577570` — `GlobalCatalogService.list` (T360 RED + T361 GREEN)
- **PR #302** @ `c4147b0` — `StoreOverrideService.create` (T372 RED + T373 GREEN) — added
  service-level cross-tenant product probe at merge time, since PG FK triggers bypass RLS
  per [PostgreSQL docs](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) and the
  original assumption ("FK to `tenant_products(id)` will fail under RLS") was wrong.
- **PR #303** @ `454a7ae` — `ProductAliasesService.create` (T383 RED + T384 GREEN)

**`MISSING_WITHSTORE_HELPER` finding resolved 2026-05-24** via path (b) of the user's
authorized resolution options: T336 reinterpreted to test the store-axis GUC contract
directly via `runWithTenantContext` + manual `SET LOCAL app.current_store`, mirroring
the T335 tenant-axis pattern. No `packages/db/src/helpers/with-store.ts` file authored
(path (a) explicitly rejected). Spec at `packages/db/__tests__/helpers/with-store-
catalog.spec.ts`; PR/commit audit fields will be filled on closeout.

**No active findings remain.**

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
| `T350_TENANT_CATALOG_CREATE_RED` | `TenantCatalogService.create` RED+GREEN — 4 cases (S1 happy path, S5 forbidden tenant-id ignored, S7 cross-tenant non-disclosure, audit emission). Closeout fix: seeded actor user to satisfy `audit_events.actor_user_id` FK. | PR #300 @ `2bf7e27` |
| `T360_GLOBAL_CATALOG_LIST_RED` | `GlobalCatalogService.list` RED+GREEN — active-only filter, identical visibility across tenants. Closeout fix: runtime guard on `@Optional()` `PG_POOL` (CodeRabbit §XII object-safety). | PR #301 @ `f577570` |
| `T372_STORE_OVERRIDE_CREATE_RED` | `StoreOverrideService.create` RED+GREEN — S1 create, S2 cross-store deny, S3 cross-tenant deny, **S4 cross-tenant product probe** (service-level pre-INSERT check since PG FKs bypass RLS), S5 Q8 forbidden fields via `hasOwnProperty`. Closeout fixes: `env.app` (was reading undefined `env.host` → ECONNREFUSED) + CodeRabbit hygiene. | PR #302 @ `c4147b0` |
| `T383_PRODUCT_ALIASES_UNIQUENESS_RED` | `ProductAliasesService.create` RED+GREEN — eight groups (tenant-wide uniq, cross-tenant ok, external_pos_id scoping, store-scoped uniq, store+tenant coexistence, FK/CHECK violations). Closeout fix: consolidated `isUniqueViolation` (collapsed cause-recursion branch) to close global branch-coverage gap (89.97% → ≥90%). | PR #303 @ `454a7ae` |

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

### `MISSING_WITHSTORE_HELPER` — RESOLVED (via T336 reinterpretation)

- **Resolved by:** T336 (slice on `test/003-t336-store-guc-coverage`; PR/commit set on closeout)
- **Originally affected:** `packages/db/src/helpers/with-store.ts` (the file that the 003 spec claimed shipped from feature 001 but had never been scaffolded — `ls packages/db/src/helpers/` returned only `audit-insert.ts` and `with-tenant.ts`).
- **Mechanism of fix:** **Path (b) of the user's authorized options.** Reinterpreted T336 to test the underlying store-GUC contract that any future `withStore` helper would compile to — `runWithTenantContext` (production tenant-axis glue) + manual `SELECT set_config('app.current_store', $1, true)` per transaction — exactly the call shape used by the rejected path (a). The new spec at `packages/db/__tests__/helpers/with-store-catalog.spec.ts` mirrors the T335 tenant-axis spec exactly, exercising 7 cases against the final-form (0011) `store_product_overrides_select` policy: (A) own-store, (B) sibling-store, (C) carve-out sentinel `'*'`, (D) never-set fail-closed, (E) cross-tenant store id, (F) symmetry, (G) runtime-role sanity.
- **Path NOT taken:** path (a) — authoring `packages/db/src/helpers/with-store.ts`. That would have touched the `[GATED]` `packages/db/src/helpers/**` surface for an API the catalog services don't actually use (they call `runWithTenantContext` + `set_config` directly — see PR #302's `StoreOverrideService.create`). The reinterpretation tests the operational contract instead of a vestigial TS wrapper.
- **Verification (planned):** `pnpm --filter @data-pulse-2/db test "__tests__/helpers/with-store-catalog.spec.ts"` → GREEN 7/7. Sanity run with `MIGRATION_TEST_ALLOW_SKIP=1` exercises the Docker-skip path locally.
- **Audit kept because:** documents the "spec claims a helper that never shipped" gotcha and the operational-contract-over-TS-wrapper pattern — valuable context if a future slice asks "where does our store-axis isolation glue live?" Answer: it doesn't have a dedicated helper; it composes inside `runWithTenantContext` via an extra `set_config` call.

---

## Active findings

_None._ The previously-active `MISSING_WITHSTORE_HELPER` was resolved 2026-05-24 via T336 reinterpretation — see Resolved findings above.

---

## Blocked

_None._ `T336` was the only slice blocked on `MISSING_WITHSTORE_HELPER`; with the finding resolved, T336 is now in **Ready / in-flight** below.

---

## Ready / in-flight

- **`T336`** — Store GUC contract coverage on `store_product_overrides`. Reinterpreted per
  finding `MISSING_WITHSTORE_HELPER` path (b). New spec authored at
  `packages/db/__tests__/helpers/with-store-catalog.spec.ts` on branch
  `test/003-t336-store-guc-coverage`; 7 cases (A own-store / B sibling-store / C carve-out
  `'*'` / D never-set fail-closed / E cross-tenant store id / F symmetry / G runtime-role
  sanity). Awaiting commit + PR per user's "Stop before commit" instruction on the
  resolving prompt.

---

## Proposed (awaiting approval)

_None._ `PHASE3_RED_WAVE` is fully merged — see "Merged on `main`" above.

---

## Next recommended action

**Phase 3's service-layer surface is on `main`** and **T336 is ready to ship** (spec
authored locally; resolves the last open 003 finding). Downstream consumers (the 005
Wave 2 reconciliation slices in particular) can now reference
`TenantCatalogService.create`, `GlobalCatalogService.list`, `StoreOverrideService.create`,
and `ProductAliasesService.create` as committed contracts.

**Recommended next steps:**

1. **Commit + PR T336.** The branch `test/003-t336-store-guc-coverage` carries the new
   spec at `packages/db/__tests__/helpers/with-store-catalog.spec.ts`. Resolves the
   `MISSING_WITHSTORE_HELPER` finding. Authoring stopped before commit per the user's
   prompt; resume the closeout protocol once the user explicitly authorizes the commit.
2. **Unblock 005 Wave 2 authoring.** With T350 + T383 on `main`, the dependency note in
   [`specs/005-pos-catalog-sync-reconciliation/wave-status.md`](../005-pos-catalog-sync-reconciliation/wave-status.md)
   is cleared. Run `/speckit-tasks` for spec 005 to extend its `tasks.md` and
   `execution-map.yaml` with the Wave 2 reconciliation slices (`005-WAVE2-*`).

No findings remain. No medium-severity work outstanding on this spec.

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

Authorize the T336 commit + PR (the spec is already authored on
`test/003-t336-store-guc-coverage`):

```text
Use Agent OS. Commit and PR slice T336.
Spec: specs/003-catalog-foundation
Branch: test/003-t336-store-guc-coverage
Resolves: finding MISSING_WITHSTORE_HELPER (path b)
```

Hand off to 005 to author the now-unblocked Wave 2 reconciliation slices:

```text
Use Agent OS. Author Wave 2 reconciliation tasks.
Spec: specs/005-pos-catalog-sync-reconciliation
Dependency cleared: 003 PHASE3_RED_WAVE merged (PR #300/#301/#302/#303).
Stop before commit.
```
