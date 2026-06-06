# Quickstart — 017 ERPNext Reconciliation & Repair

How to exercise + verify 017 once it ships. All DB-backed specs run under WSL
Testcontainers (`reference_007_test_env`); use `MIGRATION_TEST_ALLOW_SKIP=1` for
Docker-less local runs and `WORKER_INCLUDE_DB_TESTS=1` for the worker run spec.

## Prerequisites (all on `main`)

- 015 `erpnext_posting_status` (`0019`) — the posting dead-letters 017 reads.
- 014 `erpnext_warehouse_map` (`0018`) — the store→warehouse mapping.
- 009 `stock_movements` (`0014`) — DP2 compute-on-read on-hand.
- The new `[GATED]` `0020` reconciliation tables + the `[GATED]`
  `reconciliation.yaml` operator contract (authored in their gated slices).

## US1 🎯 — review the posting dead-letter backlog

1. Seed a tenant with mixed `erpnext_posting_status` rows: 3 `permanently_rejected`
   (classes `unmapped_item`, `unmapped_store`, `validation`) + 2 healthy
   (`posted`, `pending`).
2. As the Tenant Admin (cookie session), `GET /api/v1/catalog/erpnext-reconciliation/postings/backlog`.
3. **Expect**: exactly the 3 dead-letters, each with class + originating ref +
   provenance + structured reason + dead-letter time; the 2 healthy rows absent;
   paginated/sortable/groupable by class.
4. **Isolation**: as tenant B, the same call returns none of tenant A's rows;
   an RLS-bypass probe with the wrong `app.current_tenant` returns 0 rows.

## US2 — repair a failed posting (idempotent re-post)

1. Take an `unmapped_item` dead-letter; confirm the missing 013 item map out of band.
2. `POST /postings/{workItemRef}/repair` with an `Idempotency-Key`.
3. **Expect**: the 015 row → `pending` with a re-headed `sequence`; a
   `repair_attempt` row `outcome=eligible_again`; the posting is offered on the
   connector feed again.
4. Drive a `posted` ack (the existing 012 loop) → exactly **one** `document_ref`.
5. **Idempotency**: a second repair of the now-`posted` row → `no_op_echo`
   returning the same `document_ref` (no 2nd document, no rewrite).
6. **Still-broken**: repair a dead-letter whose cause is NOT fixed → 015 row stays
   `permanently_rejected`, `repair_attempt.outcome=still_failing`, it returns to
   the backlog with its class intact.
7. **Immutability**: assert the 008 `sales` row is byte-for-byte unchanged
   before/after every repair.

## US3 — stock reconciliation run + mismatch report

1. Map a store (014); seed a known DP2 on-hand divergence (009); provide a
   stub/recorded ERPNext-Bin view (connector seam, research R3).
2. `POST /runs` for `(tenant, store)` → a run id; the worker processor executes.
3. `GET /runs/{runId}` → `completed` + summary counts by class;
   `GET /runs/{runId}/results` → one classified line per compared item, using
   014's vocabulary.
4. **Expect**: an unmapped store → `unmapped_store` (never a guessed warehouse);
   the 009 ledger + 008 sale fact unchanged by the run (verify before/after).
5. `POST /runs/{runId}/results/{resultId}/repair` for an actionable class →
   idempotent re-map/re-sync recorded; no ledger mutation.

## Observability

- A `permanently_rejected` transition (already 015) + each run/repair outcome
  increments the **shared** `erpnext_posting_reconciliation_total` family (+ any
  017 run/repair counter) in `api.metrics.ts` / `worker.metrics.ts` — unlabeled,
  no PII/money/raw payloads. Verify by mocking the emission helper (the
  read-down/015 signals.spec idiom).

## Gate checks before each PR

```
ruff/eslint N/A (repo has no eslint — CI = `pnpm -r run build` (tsc) + tests)
pnpm -r run build                                   # tsc strict, all packages
wsl -e bash -lc "pnpm --filter @data-pulse-2/api test -- catalog/erpnext-reconciliation"
wsl -e bash -lc "WORKER_INCLUDE_DB_TESTS=1 pnpm --filter @data-pulse-2/worker test -- erpnext-reconciliation"
# the two GATED slices (0020 migration + reconciliation.yaml) need explicit owner approval first
```
