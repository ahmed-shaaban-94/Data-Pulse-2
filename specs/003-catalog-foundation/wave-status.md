# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-21 (post-#260 closeout)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `5801369` (T335 tenant helper coverage — PR #260)
**Active findings:** 1 — `MISSING_WITHSTORE_HELPER` (low severity; documentation/scaffolding mismatch, not a security defect)
**Resolved findings (kept for audit):** 1 — `RLS_CROSS_STORE_READ_LEAK` (resolved by PR #254 @ `483aae4`)

---

## TL;DR

Catalog Phase 2 is fully cleaned up. The cross-store read leak (PR #254)
and T335's tenant-helper coverage (PR #260) are both on `main`. **T340
is ready to dispatch** — authoring the catalog isolation harness unlocks
the entire T341–T344 read-sweep wave. T336 stays blocked solely on the
missing `withStore` helper (`MISSING_WITHSTORE_HELPER` finding) and
needs its own authorization path. No slice is currently `local_uncommitted`.

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
| `T341` | test | `sonnet-test` | no | Cross-tenant read sweep at `apps/api/test/catalog/isolation/cross-tenant-read.spec.ts`. T340 dep satisfied (PR #264). |
| `T342` | test | `sonnet-test` | no | Cross-store read sweep at `apps/api/test/catalog/isolation/cross-store-read.spec.ts`. T340 dep satisfied (PR #264). |
| `T343` | test | `sonnet-test` | no | RLS bypass probe at `apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts`. T340 dep satisfied (PR #264). |
| `T344` | test | `sonnet-test` | no | Malicious body-override at `apps/api/test/catalog/isolation/malicious-override.spec.ts`. T340 dep satisfied (PR #264). |

---

## Proposed (awaiting approval)

`PHASE3_RED_WAVE` — five RED test slices that can run in parallel because
their `allowed_files` touch disjoint paths under `apps/api/test/catalog/**`:

- `T340` — catalog isolation harness (also listed under Ready, since it's the harness others chain on)
- `T350_TENANT_CATALOG_CREATE_RED`
- `T360_GLOBAL_CATALOG_LIST_RED`
- `T372_STORE_OVERRIDE_CREATE_RED`
- `T383_PRODUCT_ALIASES_UNIQUENESS_RED`

Eligibility gates for the group are **now satisfied** (RLS fix merged; CI
on `main` green). Still `proposed: true` because parallel dispatch needs
explicit user endorsement.

---

## Next recommended action

**T341 solo is the most conservative next step.** T340 is on `main`;
T341–T344 are all ready. Running T341 first validates the harness in a
real execution context and lands a concrete cross-tenant read coverage
win. Sequential dispatch (T341 → T342 → T343 → T344) has the lowest
cognitive load; parallel dispatch as a T341–T344 wave is available if
you want higher throughput.

T336 is the other still-blocked slice and needs an explicit decision on
how to resolve `MISSING_WITHSTORE_HELPER` (author the missing helper,
or reinterpret T336 to test the GUC contract directly). That decision
is independent of the T341–T344 wave and can happen whenever.

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

```text
Use Agent OS. Execute slice T341. Stop before commit.
```

To run all four isolation slices in parallel:

```text
Use Agent OS. Schedule slices T341, T342, T343, T344 in parallel. Stop before dispatch.
```

Or, for the parallel wave (requires explicit endorsement):

```text
Use Agent OS. Schedule group PHASE3_RED_WAVE. Stop before dispatch.
```

For T336 specifically — only run this once you've authorized a resolution
path for `MISSING_WITHSTORE_HELPER`:

```text
Use Agent OS. Resolve finding MISSING_WITHSTORE_HELPER. Stop before commit.
```
