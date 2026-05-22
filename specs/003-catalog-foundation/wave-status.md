# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-22 (post-#279 closeout — HARNESS_FIX + 0009 store GUC CASE guard merged; T341 31/31 GREEN)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `e33fd0e` (PR #279, 2026-05-22)
**Active findings:** 1 — `MISSING_WITHSTORE_HELPER` (low; scaffold mismatch)
**Resolved findings (kept for audit):** 2 — `RLS_CROSS_STORE_READ_LEAK` (resolved PR #254 @ `483aae4`), `HARNESS_SEED_BUGS` (resolved PR #279 @ `e33fd0e`)

---

## TL;DR

T340 (PR #264), T341 (PR #268), HARNESS_FIX, and 0009_STORE_GUC_FIX (both PR #279)
are all merged. T341 is now **GREEN 31/31** — the harness seed bugs and the empty-store
GUC cast error are fixed. T342, T343, T344 are **ready to dispatch with no remaining
prerequisites**. T336 remains blocked on `MISSING_WITHSTORE_HELPER`.
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

## Ready / approved — next to dispatch

| Slice ID | Type | Agent | Approval needed? | Notes |
|---|---|---|---|---|
| `T342` | test | `sonnet-test` | no | Cross-store read sweep. T340 dep + HARNESS_FIX both satisfied. No prerequisites remaining. |
| `T343` | test | `sonnet-test` | no | RLS bypass probe. T340 dep + HARNESS_FIX both satisfied. No prerequisites remaining. |
| `T344` | test | `sonnet-test` | no | Malicious body-override. T340 dep + HARNESS_FIX both satisfied. No prerequisites remaining. |

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

**Dispatch T342–T344.** All prerequisites are satisfied: T340 (PR #264), T341 (PR #268),
HARNESS_FIX, and 0009_STORE_GUC_FIX (both PR #279) are on `main`. T342, T343, T344
can run sequentially or as a parallel wave (disjoint allowed files, independent test
paths). T336 is independent and still needs an explicit decision on
`MISSING_WITHSTORE_HELPER`.

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

Dispatch T342 (cross-store read sweep):

```text
Use Agent OS. Execute slice T342. Stop before commit.
```

Or dispatch T342–T344 in parallel (requires explicit endorsement):

```text
Use Agent OS. Schedule slices T342, T343, T344 in parallel. Stop before dispatch.
```

For T336 specifically — only run this once you've authorized a resolution
path for `MISSING_WITHSTORE_HELPER`:

```text
Use Agent OS. Resolve finding MISSING_WITHSTORE_HELPER. Stop before commit.
```
