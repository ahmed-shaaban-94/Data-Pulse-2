# Migration Safety Checklist: 0006_outbox_events.sql

**Migration file**: `packages/db/drizzle/0006_outbox_events.sql`
**Down file**: `packages/db/drizzle/0006_outbox_events.down.sql`
**Ref**: T571 (tasks.md P7 / Track C), feature 004-platform-production-readiness
**Author**: Slice 1A implementation (Lane A, 2026-05-17)
**Date**: 2026-05-17
**Constitution**: v3.0.0

---

## Summary

Creates the `outbox_events` table -- the durable transactional outbox for the
Data-Pulse-2 platform. The table is purely additive: no existing table, column,
index, constraint, or policy is modified.

Columns added: `event_id` (UUID PK), `tenant_id` (UUID NOT NULL), `store_id`
(UUID NULL), `event_type` (TEXT NOT NULL), `payload` (JSONB NOT NULL),
`delivery_state` (TEXT NOT NULL DEFAULT 'pending'; CHECK restricts to five
states), `attempts` (INT NOT NULL DEFAULT 0; CHECK >= 0), `next_attempt_at`
(TIMESTAMPTZ NULL), `last_error` (TEXT NULL), `occurred_at` (TIMESTAMPTZ NOT
NULL DEFAULT now()), `created_at` (TIMESTAMPTZ NOT NULL DEFAULT now()),
`updated_at` (TIMESTAMPTZ NOT NULL DEFAULT now()), `processed_at` (TIMESTAMPTZ
NULL), `correlation_id` (UUID NULL).

Indexes added: `outbox_events_drainer_claim_idx` (partial on drainer-claimable
states), `outbox_events_dead_letter_idx` (partial on dead_lettered),
`outbox_events_tenant_occurred_at_idx` (tenant audit history scan).

RLS added: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and one
policy `outbox_events_tenant_isolation` with matching USING + WITH CHECK
predicates using the repo-standard `current_setting('app.current_tenant', true)::uuid`
pattern.

No roles created. No GRANT statements. No existing tables altered.

---

## Pre-Flight

- [x] Migration is numbered sequentially -- `0005` was the prior migration
      (`0005_audit_retention_privileges.sql`); `0006` is the next available number.
      No gap, no duplicate.
- [x] Down migration `0006_outbox_events.down.sql` is present and reviewed.
      It drops the policy, then the three indexes, then the table (reverse order).
- [x] Migration uses `IF NOT EXISTS` on the `CREATE TABLE` and `CREATE INDEX`
      statements. `CREATE POLICY` and `ALTER TABLE ... ENABLE/FORCE` do not
      support `IF NOT EXISTS` in Postgres 16 and are safe to run on a fresh
      table (they only execute once in the same transaction).
- [x] No destructive operation is present. The migration is purely additive.
      Approval for destructive operations: N/A.

---

## Lock and Performance Risk (Principle III)

Estimated table row count at migration time: **0 rows** (brand-new table).

- [x] `CREATE TABLE IF NOT EXISTS outbox_events`: new empty table. Lock is
      brief (table-level for the duration of the `BEGIN...COMMIT` block,
      which is the entire migration). No live traffic on this table at
      migration time -- no application code reads or writes `outbox_events`
      yet (producer helper T580 is a future gated task).
- [x] `CREATE INDEX IF NOT EXISTS` (three indexes): all indexes are created
      in the same transaction as the table. The table is empty at creation
      time, so index builds are instantaneous. `CONCURRENTLY` is not
      applicable (empty table; no live traffic). Index creation holds no
      locks on existing tables.
- [x] No `ADD COLUMN`, no `SET NOT NULL`, no constraint added to any existing
      table. No `DROP` statement of any kind.
- [x] No lock_timeout or statement_timeout is required: all statements
      operate on a new empty table, so there is no contention with live
      application queries.

N/A -- migration contains only additive statements on a new table with no live traffic.

---

## Backward Compatibility (rolling deploy)

- **Old application code running against the new schema**: no errors. Old code
  does not reference `outbox_events` at all. The table simply exists and is
  unused until the producer helper (T580, future gated) is deployed.
- **New application code running against the old schema**: N/A. No application
  code for `outbox_events` is deployed in this slice (T580-T584 are future
  gated tasks). This migration ships ahead of any runtime code that uses it.
- **API response shape**: unchanged. This migration adds no endpoint, no
  controller, no OpenAPI contract change. Zero API surface change.

---

## RLS (Principle II)

- [x] `outbox_events` has an RLS policy `outbox_events_tenant_isolation`.
      The table is explicitly tenant-scoped (every row has `tenant_id NOT NULL`).
- [x] Policy uses the safe form
      `current_setting('app.current_tenant', true)::uuid` -- the `true`
      parameter makes an unset GUC return NULL so an unauthenticated or
      no-context connection matches zero rows (fail-closed).
- [x] `FORCE ROW LEVEL SECURITY` is set. This binds even the table-owner
      connection (e.g., Testcontainers superuser in CI) to the policy, so
      tests that use the admin pool must SET LOCAL explicitly if they want
      policy-filtered reads. Convention is consistent with every existing
      tenant-scoped table.
- [x] RLS test matrix: implemented in
      `packages/db/__tests__/outbox/rls.spec.ts` (T566 / T597 / T598 / T600).
      Probes: G-1 cross-tenant SELECT returns empty, G-2 correct-tenant
      positive control, G-3 symmetric, G-4 WITH CHECK rejects cross-tenant
      INSERT, G-5 FORCE RLS attribute, G-6 no BYPASSRLS on any role, G-7
      app_test role specifically has rolbypassrls=false, G-8 no-context
      returns empty, G-9 cross-table regression sweep (existing policies intact).

---

## Rollback Plan (Principle VIII)

- Down migration verified to restore the schema to its prior state: **yes**.
  `0006_outbox_events.down.sql` drops the policy, three indexes, and the
  table inside a single transaction using `IF EXISTS` guards.
- Rollback procedure:
  1. Run `packages/db/drizzle/0006_outbox_events.down.sql` against the
     target database.
  2. No application code references `outbox_events` in this slice, so no
     application rollback is needed.
- Data backfilled during the up migration: **N/A** -- no rows are inserted
  by the migration itself.
- **Rollback hazard**: none in this slice. Because no application code
  writes to `outbox_events` yet (T580 is future gated), there are no rows
  to lose on rollback. If T580 has already been deployed and events have
  been written, rolling back this migration will destroy those rows. Do
  not roll back after the producer helper is live without a data-preservation
  plan.

---

## CI Gates

- [x] Migration test runs in CI with Testcontainers (real Postgres 16-alpine)
      via the `applyAllUpAndCreateAppRole` helper which walks all migrations
      in lexicographic order.
- [x] `MIGRATION_TEST_ALLOW_SKIP=1` is supported for local development
      without Docker (soft-skip with a warning). CI does not set this flag.
- [x] New test files `packages/db/__tests__/outbox/repository.spec.ts` and
      `packages/db/__tests__/outbox/rls.spec.ts` are included in the PR and
      run against the migrated schema.

---

## Design Decisions and Deltas vs. Task Wording

1. **`delivery_state` values**: task wording listed `'in_flight'` and
   `'processed'`. This migration uses `'claimed'` and `'delivered'` per the
   design contract in `docs/outbox/lifecycle.md` section 2 and
   `docs/outbox/drainer-design.md` section 2, which the future drainer code
   (T580/T581) will be written against. The task instruction says "Re-confirm
   exact column names + types against drainer-design.md before writing" --
   the docs are the authoritative contract.

2. **`correlation_id` type**: `docs/outbox/lifecycle.md` section 2 specifies
   UUID NOT NULL. The task wording says TEXT NULL. This migration uses UUID
   NULL to match the existing UUID-for-trace-IDs convention in the repo
   (see `audit_events.request_id`) while remaining optional (correlation id
   is not always available at produce time, e.g., batch or background jobs).
   Reviewers may promote to NOT NULL if tracing requirements solidify.

3. **`store_id` column**: task column list omitted `store_id`. Added per
   `docs/outbox/lifecycle.md` section 2 ("nullable; NULL for tenant-level
   events"). Omitting it would require a future schema change when the first
   store-level event type is registered.

4. **Drainer claim index width**: partial index covers
   `delivery_state IN ('pending', 'failed')` rather than only `'pending'`
   to match the claim query shape in `drainer-design.md` section 2 which
   reclaims both pending and failed-past-backoff rows. A `'pending'`-only
   partial index would miss the retry path.

5. **No GRANT statements**: existing migrations (`0000_initial.sql`) do not
   grant to the app role inline; the test helper (`ensureAppRole`) and
   production deployment handle this externally. Adding a hardcoded grant
   here would be inconsistent with that pattern.

---

## Open Questions

1. **`correlation_id` nullability**: reviewers should confirm whether UUID
   NULL is the long-term preference or whether NOT NULL (with a nil UUID
   sentinel for no-correlation cases) is preferred for consistency with
   `lifecycle.md` section 2.

2. **`updated_at` trigger**: the table has an `updated_at` column but no
   `set_updated_at` trigger (unlike `tenants`, `stores`, etc.). The drainer
   updates `updated_at` explicitly in its UPDATE statement. If this table
   should have an automatic trigger, it needs an `ALTER TABLE ... CREATE
   TRIGGER` statement added to this or a follow-up migration. The current
   pattern (drainer-managed) is consistent with the spike findings.
