# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-21
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `696584c` (worker outbox metrics — PR #253)
**Active findings:** 1 — `RLS_CROSS_STORE_READ_LEAK` (medium severity, in review via PR #254)

---

## TL;DR

Catalog Phase 2 ships: schema (T320), schema-shape tests (T331), the four
T326–T329 RED tests for the migration, the gated 0007 migration itself
(T330), and the post-merge db-integration fallout hotfix (PR #250) are all
on `main`. While preparing the next helper-coverage slice, a cross-store
SELECT RLS leak was discovered on `store_product_overrides` and
`unknown_items`. The fix is up as PR #254 (RED proof + gated 0008
migration). T336 and the entire T340–T344 isolation harness wave stay
blocked until #254 merges. T335 has a tenant-helper coverage spec written
locally but not committed.

---

## Merged on `main`

| Slice ID | Subject | Reference |
|---|---|---|
| `T320` | Catalog schema modules (`packages/db/src/schema/catalog/`) | merged |
| `T331` | Schema-shape tests for 7 catalog tables | merged |
| `T326_T327_T328_T329` | RED tests for the 0007 migration (up, down, round-trip, RLS sweep) | merged |
| `T330` | `0007_catalog.sql` + `0007_catalog.down.sql` | merged |
| `PR250_DB_INTEGRATION_FALLOUT` | CodeRabbit fixes for `0001-catalog.spec.ts` + `outbox/rls.spec.ts` | PR #250 |

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `T335_TENANT_HELPER_COVERAGE` | `test/003-catalog-helper-foundation` | uncommitted (file on disk) | `with-tenant-catalog.spec.ts` exists in worktree `dp2-catalog-helper-foundation`; validated 5/5 GREEN against Testcontainers; not staged. Could be cherry-picked or rewritten on a fresh branch. |
| `RLS_CROSS_STORE_RED_PROOF` | `test/003-catalog-rls-cross-store-red` | `3da993b` | Pure RED proof commit; the same content is also on PR #254 as `8cf797a` via cherry-pick + rebase. |
| `RLS_CROSS_STORE_FIX` | `fix/003-catalog-rls-cross-store-read` | `85b312c` | Gated 0008 migration + rollback. **In review as PR #254.** |

---

## Active findings

### `RLS_CROSS_STORE_READ_LEAK`

- **Summary:** `store_product_overrides` and `unknown_items` each declare two PERMISSIVE SELECT policies. PostgreSQL OR-combines them, so the tenant-only policy alone grants visibility to every Tenant-A row regardless of `app.current_store`. Cross-store reads inside a tenant are not blocked at the RLS layer.
- **Affected:** `store_product_overrides`, `unknown_items` (read path only — writes are correctly isolated by the `FOR ALL` `*_tenant_write` policies)
- **Severity:** medium (tenant-internal data confidentiality; not cross-tenant; no production traffic on these tables yet)
- **Proof:** `3da993b` — `packages/db/__tests__/migration/catalog-rls-store-read.spec.ts` (2 RED assertions on Testcontainers Postgres 16)
- **Blocks:** `T336`, `T340`, `T341`, `T342`, `T343`, `T344`
- **Resolved by:** `RLS_CROSS_STORE_FIX` (PR #254 — in review)

---

## Blocked

| Slice ID | Blocked by | Notes |
|---|---|---|
| `T336` | `RLS_CROSS_STORE_FIX` + missing `withStore` helper | rls-test-matrix.md:464-465 claims `packages/db/src/helpers/with-store.ts` exists; it does not. T336 also cannot pass against current SQL because of the same RLS read leak. |
| `T340` | `RLS_CROSS_STORE_FIX` | Catalog isolation harness depends on RLS behaving correctly; building it now would bake in workarounds. |
| `T341` | `T340` | Cross-tenant read sweep. |
| `T342` | `T340`, `RLS_CROSS_STORE_FIX` | Cross-store read sweep — directly relies on the fix. |
| `T343` | `T340` | RLS bypass probe (raw SQL). |
| `T344` | `T340` | Malicious body-override probe. |

---

## Ready / approved — next to dispatch

| Slice ID | Type | Agent | Approval needed? | Notes |
|---|---|---|---|---|
| _(none — `RLS_CROSS_STORE_FIX` is the only active slice, currently in review as PR #254)_ | — | — | — | — |

---

## Proposed (awaiting approval)

Phase-3 RED tests, gated as a parallel group once the RLS fix and
db-integration on `main` are both green. Touches disjoint
`apps/api/test/catalog/**` paths so `parallel_safety: safe`:

- `T340` — catalog isolation harness
- `T350_TENANT_CATALOG_CREATE_RED`
- `T360_GLOBAL_CATALOG_LIST_RED`
- `T372_STORE_OVERRIDE_CREATE_RED`
- `T383_PRODUCT_ALIASES_UNIQUENESS_RED`

Group ID in execution-map: `PHASE3_RED_WAVE`. Status: `proposed`.

---

## Next recommended action

Land PR #254 (`RLS_CROSS_STORE_FIX`). That unblocks all of T336 + T340–T344
and clears the only active finding. After it merges and CI on `main` is
green, ask Maestro to schedule `PHASE3_RED_WAVE` — five independent
RED-test slices that can run in parallel because their `allowed_files` do
not overlap.

T335's local work is independent of the RLS fix and can be committed at
any time (or rewritten as a fresh slice once Agent OS v1 is the active
workflow).

---

## Next short Maestro prompt

When PR #254 merges:

```text
Use Agent OS. Schedule group PHASE3_RED_WAVE. Stop before dispatch.
```

When you want to land T335's local work as a follow-up:

```text
Use Agent OS. Execute slice T335_TENANT_HELPER_COVERAGE. Stop before commit.
```

If new findings come up that should be captured before any further work:

```text
Use Agent OS. Capture finding <ID> into the catalog execution map.
```
