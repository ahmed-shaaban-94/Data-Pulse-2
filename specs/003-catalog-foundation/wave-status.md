# Wave Status — `003-catalog-foundation`

**Last updated:** 2026-05-21 (post-#254 merge)
**Spec:** [`specs/003-catalog-foundation/`](.)
**Base:** `origin/main` at `483aae4` (RLS cross-store isolation fix — PR #254)
**Active findings:** 1 — `MISSING_WITHSTORE_HELPER` (low severity; documentation/scaffolding mismatch, not a security defect)
**Resolved findings (kept for audit):** 1 — `RLS_CROSS_STORE_READ_LEAK` (resolved by PR #254 @ `483aae4`)

---

## TL;DR

Catalog Phase 2 closed cleanly. The RLS cross-store read leak that surfaced
during the T335/T336 helper wave was fixed and merged as PR #254 — both
affected tables (`store_product_overrides`, `unknown_items`) now AND-gate
SELECT by tenant AND store. T340 is **ready to dispatch**; T341–T344 are
chain-blocked on T340 (no longer on any finding). T336 remains blocked,
but solely on the missing `withStore` helper — a separate documented
finding that needs its own authorization path. T335's tenant-helper
coverage spec exists `local_uncommitted` and can be landed any time.

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

### Context from neighboring merges since previous refresh

These landed alongside the catalog work and affect the surrounding context, not catalog directly:

- **PR #256** (`docs(agent-os): add spec execution layer`) — Agent OS v1 docs landed at `a482842`. The map you're reading now is governed by `docs/agent-os/slice-schema.yaml`.
- **PR #257** (`ci: remove Codecov coverage upload step`) — landed at `1bd5161`. The recurring `db-integration` Codecov `AggregateError` false-FAILURE is gone from CI; future PRs will not show that flake.
- **PR #255** (T565 worker outbox redaction it.todo gaps) — landed at `c182a27`. Worker-side, no catalog impact.

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `T335_TENANT_HELPER_COVERAGE` | `test/003-catalog-helper-foundation` | uncommitted (file on disk) | `with-tenant-catalog.spec.ts` exists in worktree `dp2-catalog-helper-foundation`; validated 5/5 GREEN against Testcontainers; status `local_uncommitted`. Can be cherry-picked or rewritten on a fresh branch. |

The two RLS slices (`RLS_CROSS_STORE_RED_PROOF`, `RLS_CROSS_STORE_FIX`)
previously listed here are now on `main` via PR #254 and have moved to
the [Merged](#merged-on-main) table.

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
- **Proof:** `ls packages/db/src/helpers/` on `main @ 483aae4` returns only `audit-insert.ts` and `with-tenant.ts`.
- **Blocks:** `T336` only.
- **Resolution paths (either, with explicit user approval):**
  1. **New gated slice** authors `packages/db/src/helpers/with-store.ts` (forbidden surface — needs approval).
  2. **Reinterpret T336** to test the store GUC contract via `runWithTenantContext` + manual `SET LOCAL app.current_store`, treating "the helper's contract" rather than "the helper's TS surface" as the unit under test. This is the same shape the local `T335_TENANT_HELPER_COVERAGE` spec uses for the tenant side.

---

## Blocked

| Slice ID | Blocked by | Notes |
|---|---|---|
| `T336` | `MISSING_WITHSTORE_HELPER` finding | No remaining slice-level deps — `RLS_CROSS_STORE_FIX` cleared. Only the missing helper file blocks now. |
| `T341` | `T340` | Cross-tenant read sweep — chain-blocked on harness, no longer on the RLS finding. |
| `T342` | `T340` | Cross-store read sweep — chain-blocked on harness; the RLS fix is now in place so this test is expected to be authorable as RED→GREEN against the corrected SQL. |
| `T343` | `T340` | RLS bypass probe — chain-blocked on harness. |
| `T344` | `T340` | Malicious body-override — chain-blocked on harness. |

---

## Ready / approved — next to dispatch

| Slice ID | Type | Agent | Approval needed? | Notes |
|---|---|---|---|---|
| `T340` | test | `sonnet-test` | no | Catalog isolation harness at `apps/api/test/catalog/__support__/isolation-harness.ts`. Unblocks T341–T344. No gated surface. |
| `T335_TENANT_HELPER_COVERAGE` | test | `sonnet-test` | no | `local_uncommitted` — file exists in `dp2-catalog-helper-foundation` worktree, validated 5/5 GREEN. Could be committed as-is or re-authored via a fresh Agent OS slice. |

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

**Run `T335_TENANT_HELPER_COVERAGE` first.** It's the most conservative
play — small slice, no gated surface, completes already-validated work
that's sitting `local_uncommitted` in a worktree. Lands a clean RLS-side
coverage win on `main` and leaves the heavier Phase-3 wave for a separate
authorization step.

After T335 lands, the next move is one of:

1. **`T340` solo** — author the isolation harness on its own, then dispatch T341–T344 as ready slices once the harness lands. Sequential, lowest cognitive load.
2. **`PHASE3_RED_WAVE` group** — dispatch T340 + T350/T360/T372/T383 in parallel (five worktrees, five branches). Requires explicit endorsement of the group. Highest throughput but most coordination overhead.

---

## Next short Maestro prompt

```text
Use Agent OS. Execute slice T335_TENANT_HELPER_COVERAGE. Stop before commit.
```

After T335 merges, either of these is appropriate:

```text
Use Agent OS. Execute slice T340. Stop before commit.
```

or

```text
Use Agent OS. Schedule group PHASE3_RED_WAVE. Stop before dispatch.
```

For T336 specifically — only run this once you've authorized a resolution
path for `MISSING_WITHSTORE_HELPER`:

```text
Use Agent OS. Resolve finding MISSING_WITHSTORE_HELPER. Stop before commit.
```
