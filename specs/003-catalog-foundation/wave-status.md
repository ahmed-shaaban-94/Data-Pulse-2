# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-22 (post-#268 closeout — T341 cross-tenant read isolation merged)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `263492a` (T341 — PR #268, 2026-05-21)
**Active findings:** 2 — `MISSING_WITHSTORE_HELPER` (low; scaffold mismatch), `HARNESS_SEED_BUGS` (medium; 3 latent seed errors verified on main @ f6a8075)
**Resolved findings (kept for audit):** 1 — `RLS_CROSS_STORE_READ_LEAK` (resolved by PR #254 @ `483aae4`)

---

## TL;DR

T340 (isolation harness, PR #264) and T341 (cross-tenant read isolation, PR #268)
are both merged. T342, T343, T344 are now **ready to dispatch**. A new finding —
`HARNESS_SEED_BUGS` — records three latent constraint violations in the harness seed
function (independently verified against main @ f6a8075 by static inspection and
Testcontainers run). A **harness fix slice must land before T342 validation** — all
three consume the same seeding function. T336 remains blocked on
`MISSING_WITHSTORE_HELPER`. No slice is `local_uncommitted`.

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
| `T340` | Catalog isolation harness (`apps/api/test/catalog/__support__/isolation-harness.ts`) | PR #264 @ `02cdf75` — *see HARNESS_SEED_BUGS* |
| `T341` | Cross-tenant read isolation (`apps/api/test/catalog/isolation/cross-tenant-read.spec.ts`) — 29 assertions, Groups A–D | PR #268 @ `263492a` |

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

### `RLS_CROSS_STORE_READ_LEAK` — RESOLVED

- **Resolved by:** `RLS_CROSS_STORE_FIX` (PR #254 @ `483aae4`, merged 2026-05-21)
- **Originally affected:** `store_product_overrides`, `unknown_items` (read path only)
- **Mechanism of fix:** dropped the two split PERMISSIVE SELECT policies per table and replaced them with one combined policy that AND-gates `tenant_id` and `(store_id OR app.current_store = '')`. Preserves the tenant-owner empty-string carve-out documented in `rls-test-matrix.md §4.3`.
- **Verification:** RED proof `catalog-rls-store-read.spec.ts` flipped from 2/2 RED to 2/2 GREEN. Regression sweep on `migration/0001-catalog`, `outbox/rls`, and `schema/catalog` all stayed green.
- **Audit kept because:** the spec's `rls-test-matrix.md` cites this resolution as the model for future split-permissive bugs; deleting the finding would erase that pointer.

---

## Active findings

### `HARNESS_SEED_BUGS` — fix slice required before T342 dispatch

- **Summary:** Three latent constraint violations in `seedCatalogIsolationFixture` (`apps/api/test/catalog/__support__/isolation-harness.ts`) merged via PR #264. All three were independently verified by static inspection against `0007_catalog.sql` on main @ f6a8075 and confirmed by a Testcontainers run (WSL Docker, 2026-05-22 — 31/31 FAILED).
  1. `product_aliases` INSERT column list omits `created_by` (NOT NULL per `0007_catalog.sql:275`).
  2. `product_aliases` store-scoped rows use `identifier_type = 'external_pos_id'` with `store_id` set, violating the `product_aliases_store_scope_consistency` CHECK (`external_pos_id` must have `store_id NULL`, per `0007_catalog.sql:284-285`).
  3. `price_history` INSERT uses column `created_by` (does not exist — correct column is `changed_by`, `0007_catalog.sql:335`) and omits `correlation_id` (NOT NULL, `0007_catalog.sql:336`).
- **Severity:** medium — all T341–T344 validation runs will fail at seed time until fixed; no production impact.
- **Blocks:** T342, T343, T344 validation (T341 is already merged but its GREEN run is also blocked until fixed).
- **Resolution:** New fix slice targeting `isolation-harness.ts`. No gate required (non-forbidden path; test-only file).

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
| T342 validation | `HARNESS_SEED_BUGS` | Slice is `ready` (T340 dep cleared). Harness fix is a runtime prerequisite for GREEN — not a dispatch blocker, but validation will fail until resolved. Same applies to T343, T344. |

---

## Ready / approved — next to dispatch

| Slice ID | Type | Agent | Approval needed? | Notes |
|---|---|---|---|---|
| `HARNESS_FIX` *(new, unregistered)* | fix | `sonnet-test` | no | Fix three seed bugs in `isolation-harness.ts` per `HARNESS_SEED_BUGS` finding. Must land before T342 dispatch to get GREEN. |
| `T342` | test | `sonnet-test` | no | Cross-store read sweep. T340 dep satisfied (PR #264). Requires harness fix for GREEN validation. |
| `T343` | test | `sonnet-test` | no | RLS bypass probe. T340 dep satisfied (PR #264). Requires harness fix for GREEN validation. |
| `T344` | test | `sonnet-test` | no | Malicious body-override. T340 dep satisfied (PR #264). Requires harness fix for GREEN validation. |

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

**Fix the harness first.** T341 and T340 are on `main`. T342–T344 are ready to
dispatch but all use `seedCatalogIsolationFixture` — the three bugs will cause
seed-time failures until patched. The fix is three INSERT corrections in
`isolation-harness.ts`, no gate required, and should land as a single commit
before T342 is dispatched.

After the harness fix, T342–T344 can run sequentially or as a parallel wave
(disjoint allowed files, independent test paths). T336 is independent and still
needs an explicit decision on `MISSING_WITHSTORE_HELPER`.

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

Fix harness seed bugs (required before T342 dispatch):

```text
Use Agent OS.
Fix finding HARNESS_SEED_BUGS in isolation-harness.ts.
Spec: specs/003-catalog-foundation
Allowed file: apps/api/test/catalog/__support__/isolation-harness.ts
Stop before commit.
```

After harness fix lands, dispatch the T342–T344 wave:

```text
Use Agent OS. Execute slice T342. Stop before commit.
```

Or in parallel (requires explicit endorsement):

```text
Use Agent OS. Schedule slices T342, T343, T344 in parallel. Stop before dispatch.
```

For T336 specifically — only run this once you've authorized a resolution
path for `MISSING_WITHSTORE_HELPER`:

```text
Use Agent OS. Resolve finding MISSING_WITHSTORE_HELPER. Stop before commit.
```
