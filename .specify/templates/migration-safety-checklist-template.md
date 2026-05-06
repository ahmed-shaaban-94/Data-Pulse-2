# Migration Safety Checklist: [Migration Description]

**Migration file**: [path — e.g., `packages/db/migrations/0042_add_foo_to_bar.sql`]
**Ref**: [spec-id or task ID]
**Author**: [name or role]
**Date**: YYYY-MM-DD
**Constitution**: vX.Y.Z

---

## Summary

One paragraph: what tables, columns, constraints, indexes, or policies this
migration adds, changes, or removes, and why. Be concrete — "adds nullable
column `external_ref TEXT` to `entities`; adds partial UNIQUE index on
`(external_ref) WHERE external_ref IS NOT NULL`; replaces an old CHECK
constraint with a revised one."

---

## Pre-Flight

- [ ] Migration is numbered sequentially (no gaps, no duplicates in
      `packages/db/migrations/`)
- [ ] Down migration (`NNNN_*.down.sql` or documented inverse) is present
      and reviewed
- [ ] Migration uses `IF NOT EXISTS` / `IF EXISTS` where idempotency
      applies (verify each statement)
- [ ] Any destructive operation has explicit approval recorded at: [link]
      *(Drop column, drop table, remove constraint — these require approval
      per Constitution §VIII. Mark "N/A" if no destructive operation.)*

---

## Lock and Performance Risk (Principle III)

Estimated table row count at migration time: [N rows / unknown]

For each statement in the migration, tick the applicable check:

- [ ] `ALTER TABLE … ADD COLUMN`:
  - No default → no backfill required, lock is brief.
  - Has default → backfill strategy: [describe — or "column is nullable,
    backfill deferred to application code before constraint is tightened"]
- [ ] `CREATE INDEX`:
  - Uses `CONCURRENTLY` on any table with live traffic or > ~1M rows.
  - *(Standard `CREATE INDEX` on an empty or brand-new table is fine.)*
- [ ] `ADD CONSTRAINT NOT NULL` or `SET NOT NULL`:
  - Column was pre-populated before this migration, OR migration sets a
    DEFAULT first, then adds the constraint in the same transaction.
- [ ] `DROP COLUMN` / `DROP TABLE`:
  - Application code that reads or writes this column / table has already
    been deployed and removed before this migration runs.
- [ ] Statement / lock timeout:
  - Set for any statement operating on a table expected to be > 10M rows
    in production. Value used: [e.g., `SET lock_timeout = '5s'`]

*(Delete checks that don't apply. If none apply, write "N/A — migration
contains only additive statements on a new table with no live traffic.")*

---

## Backward Compatibility (rolling deploy)

Answer each question. If the deployment is not rolling (e.g., maintenance
window with full downtime), write "N/A — maintenance window deploy."

- Old application code running against the new schema: [errors / no errors — explain]
- New application code running against the old schema during rolling
  deploy: [errors / no errors — explain]
- API response shape: [unchanged / new version introduced — or "N/A — no
  API surface change"]

---

## RLS (if new or changed tenant-scoped table — Principle II)

*(Delete this section if the migration touches no tenant-scoped tables.)*

- [ ] New table has an RLS policy — or is explicitly designated
      non-tenant-scoped with justification: ___
- [ ] Policy uses the safe form
      `current_setting('app.current_tenant', true)::uuid` so an unset GUC
      yields NULL and matches no rows
- [ ] `FORCE ROW LEVEL SECURITY` is set on the table (or justified why not)
- [ ] RLS test matrix filled and linked: [link]

---

## Rollback Plan (Principle VIII)

Every migration ships with a documented rollback path.

- Down migration verified to restore the schema to its prior state: yes / no
- Rollback procedure:
  1. [Step — e.g., "run `0042_add_foo_to_bar.down.sql`"]
  2. [Step — e.g., "re-deploy the prior application version"]
- Data backfilled during the up migration is reversible: yes / no / N/A
- **Rollback hazard** (if any): [describe — e.g., "rolling back this
  migration after live records are created will [consequence]. Schedule
  rollback in a maintenance window."]

---

## CI Gates

- [ ] Migration test runs in CI with Testcontainers (real Postgres) enabled
- [ ] `MIGRATION_TEST_ALLOW_SKIP=1` is NOT set in CI (or the test code
      explicitly supports this flag and the reason is documented: ___)

---

## Open Questions

Each must be resolved before this migration is approved for merge.

1. [Question]

---

> **When to use this template**
> Fill this for every PR that includes a new or modified migration file
> (`.sql` or Drizzle schema change). Link the filled checklist from the PR
> description's Architecture Impact Map DB gate pointer: "RLS /
> tenant-context strategy required." The most critical checks are Lock and
> Performance Risk, Backward Compatibility, and Rollback Plan — do not skip
> these even for migrations that look simple.
>
> **When NOT to use this template**
> PRs with no migration files. Seed-data or one-off scripts already in
> `scripts/oneoff/`. Test-fixture changes that do not touch the real schema.
> Documentation-only PRs.
