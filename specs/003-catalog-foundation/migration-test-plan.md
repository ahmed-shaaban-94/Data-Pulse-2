# Catalog Foundation Phase 2 — Migration Test Plan (T326–T329)

- **Ref**: 003-catalog-foundation Phase 2 migration-test plan (T326–T329)
- **Status**: Draft — planning artifact; NO executable tests in this PR
- **Constitution**: v3.0.0
- **Date**: 2026-05-16
- **Author**: Lane C
- **Cross-references**:
  - `specs/003-catalog-foundation/spec.md`
  - `specs/003-catalog-foundation/plan.md`
  - `specs/003-catalog-foundation/research.md`
  - `specs/003-catalog-foundation/data-model.md` (Q1–Q12 bindings)
  - `specs/003-catalog-foundation/rls-test-matrix.md`
  - `specs/003-catalog-foundation/redaction-matrix.md`
  - `specs/003-catalog-foundation/quickstart.md`
  - `specs/003-catalog-foundation/pos-read-model-direction.md`
  - `specs/003-catalog-foundation/tasks.md` §5.3 — T326–T331 (authoritative
    task definitions and predecessor DAG)
  - `specs/003-catalog-foundation/phase2-gate-plan.md` — Lane A gate plan,
    sibling PR

> This document is the planning artifact for the four migration-test tasks
> T326–T329. It defines exactly what each test must assert, in what file,
> against what fixtures, and in what order. It does **not** author executable
> tests, migration SQL, schema source, or Drizzle barrels. Implementation
> lands in a follow-up gated PR pairing T326–T329 with T330 (and after T320
> + T331 have been approved per the §5.3 DAG).

---

## Contents

1. [Purpose](#1-purpose)
2. [Why planning-only](#2-why-planning-only)
3. [Authoritative task definitions vs prompt assertions](#3-authoritative-task-definitions-vs-prompt-assertions)
4. [Future target test files](#4-future-target-test-files)
5. [Testcontainers setup expectations](#5-testcontainers-setup-expectations)
6. [T326 — Forward migration applies cleanly + creates seven tables, indexes, RLS, CHECKs, partial UQ indexes](#6-t326--forward-migration-applies-cleanly--creates-seven-tables-indexes-rls-checks-partial-uq-indexes)
7. [T327 — Rollback restores pre-migration state](#7-t327--rollback-restores-pre-migration-state)
8. [T328 — No cascading FK from tenant_products to global_products (Q5)](#8-t328--no-cascading-fk-from-tenant_products-to-global_products-q5)
9. [T329 — Numeric money type + non-negative CHECK on every money column (Q1)](#9-t329--numeric-money-type--non-negative-check-on-every-money-column-q1)
10. [Cross-cutting RLS inventory expectations](#10-cross-cutting-rls-inventory-expectations)
11. [Cross-cutting index inventory expectations](#11-cross-cutting-index-inventory-expectations)
12. [Cross-cutting CHECK constraint inventory expectations](#12-cross-cutting-check-constraint-inventory-expectations)
13. [Test fixture strategy](#13-test-fixture-strategy)
14. [Relationship to T330 migration implementation](#14-relationship-to-t330-migration-implementation)
15. [Out-of-scope (explicit non-goals)](#15-out-of-scope-explicit-non-goals)
16. [Risks and mitigations](#16-risks-and-mitigations)
17. [Open questions for the implementation PR](#17-open-questions-for-the-implementation-pr)

---

## 1. Purpose

- Define exactly what each of T326–T329 must assert against the as-yet-unwritten
  catalog migration.
- Define the future test file paths, the Testcontainers harness expectations,
  the fixture strategy, and the migration-name reconciliation required before
  any code is written.
- Surface conflicts between `tasks.md §5.3` (authoritative) and the Lane C
  prompt's per-test assertion split so the implementation PR can be merged
  unambiguously.

This document does **not** author executable tests. It does **not** author the
catalog SQL migration. It does **not** modify any schema source, OpenAPI
contract, or workflow.

## 2. Why planning-only

T326–T329 sit at this position in the §5.3 DAG:

```
T320 (schema source, GATED)
  -> T331 (barrel re-export, GATED)
    -> T326 (creation test; predecessors T320, T331)
      -> T327 (rollback test; predecessor T326)
      -> T328 (no-cascade FK test; predecessor T326)
      -> T329 (money numeric test; predecessor T326)
        -> T330 (author migration + rollback, GATED)
```

Authoring executable tests now would either:

1. Compile-fail because T320's Drizzle schema source does not yet exist and
   T331's barrel does not re-export the catalog schemas, producing a
   different RED state from Lane B's unit-level RED. The barrel is the only
   import surface tests use to resolve catalog types.
2. Require Lane C to author the schema scaffolding itself, which the §5.3
   gate list explicitly forbids and which sits outside this lane's
   single-file allowlist.

This lane therefore delivers a plan only. Executable tests land in a
follow-up PR after T320 and T331 are merged, ideally bundled with T330 (see
§14).

## 3. Authoritative task definitions vs prompt assertions

`tasks.md §5.3` is the source of truth for what each of T326–T329 asserts.
The Lane C prompt distributed the assertions differently. This plan follows
`tasks.md` (primary source) and folds the prompt's additional assertions into
the appropriate test per `tasks.md`'s scope.

| Task | tasks.md scope (authoritative) | This plan honors |
|---|---|---|
| T326 | All seven tables, indexes, RLS policies, CHECK constraints, partial UQ indexes exist post-migration; none of them exist pre-migration. | All §6 assertions, including the full RLS inventory (§10), index inventory (§11), and CHECK inventory (§12). |
| T327 | Rollback restores pre-migration state. | §7 — drops all seven tables, removes RLS policies, removes Drizzle migration row, leaves zero orphan catalog objects. |
| T328 | No FK from `tenant_products` to `global_products` has `ON UPDATE CASCADE` or `ON DELETE CASCADE`. Q5. | §8 — the prompt's recommended approach is **wrong on this point**: per `data-model.md §3` there is **no FK at all** between `tenant_products.source_global_product_id` and `global_products.id`. T328 asserts the absence of the FK and the soft-reference behavior. See §16-R1. |
| T329 | Every `numeric` money column is `numeric(19,4)` with a `CHECK (... >= 0)`. Q1. | §9 — all eight money columns enumerated from `data-model.md`, plus the price-history non-negative CHECK. |

This plan does not re-scope the tasks. Implementation PRs MUST keep
T326–T329 in their `tasks.md §5.3` scope. If a future PR wants to split T326
into smaller files, it must amend `tasks.md` first.

## 4. Future target test files

| Task | Future test file | Naming basis |
|---|---|---|
| T326 | `packages/db/__tests__/migration_catalog.spec.ts` | Existing convention is one file per migration in `packages/db/__tests__/` (see `migration_0001.spec.ts`). `tasks.md` proposed `packages/db/__tests__/migration/0001-catalog.spec.ts` (new subdirectory). The implementation PR MUST pick one and amend `tasks.md` accordingly. See §16-R3. |
| T327 | Co-located with T326 in `migration_catalog.spec.ts` as a final `describe("rollback")` block, OR a sibling file `migration_catalog_rollback.spec.ts`. The existing `migration_0001.spec.ts` co-locates the UP -> DOWN -> UP cycle in a single file (see `migration_0001.spec.ts:440`). Recommended: follow that precedent — one file. |
| T328 | Co-located in `migration_catalog.spec.ts` as a `describe("Q5 / non-cascading source provenance")` block, OR a sibling file `migration_catalog_provenance.spec.ts`. Recommended: co-locate. |
| T329 | Co-located in `migration_catalog.spec.ts` as a `describe("Q1 / numeric money columns")` block, OR a sibling file `migration_catalog_money.spec.ts`. Recommended: co-locate. |

The recommended outcome is one file (`migration_catalog.spec.ts`) with four
top-level `describe` blocks, mirroring `migration_0001.spec.ts`. If the
file would exceed ~800 lines, split T328 and T329 into siblings and keep
T326 + T327 together.

## 5. Testcontainers setup expectations

- Reuse `packages/db/__tests__/_helpers/postgres-container.ts` — confirmed
  via direct read of the file. The helper already exposes:
  - `startPgEnv()` — boots `postgres:16-alpine` and returns admin + app
    pools.
  - `applyAllUpAndCreateAppRole(env)` — applies every `.sql` file under
    `packages/db/drizzle/` in lex order, then creates the non-superuser
    `app_test` role for RLS assertions.
  - `APP_ROLE_NAME = "app_test"` (non-superuser; **MUST NOT** have
    `BYPASSRLS`).
- Each test starts with a clean Postgres 16-alpine container (matching
  production per Constitution §8).
- Migration application order is **lex order over `packages/db/drizzle/`**.
  As of 2026-05-16, the existing files are:
  - `0000_initial.sql`
  - `0001_pos_operator_identity.sql`
  - `0002_shifts.sql`
  - `0003_session_active_store_tenant_invariant.sql`
  - `0004_audit_retention_marker.sql`
  - `0005_audit_retention_privileges.sql`
- The catalog migration filename in `tasks.md §5.3` is
  `packages/db/drizzle/0001_catalog.sql`. That **conflicts** with the
  existing `0001_pos_operator_identity.sql`. The next free number in lex
  order is **`0006_catalog.sql`** (with rollback `0006_catalog.down.sql`).
  The implementation PR (T330) MUST resolve this naming conflict before
  any test imports its path. See §16-R2 and §17-Q1.
- Tests SHOULD apply the full lex-ordered chain so the catalog migration
  runs against a realistic Phase 1 schema (RLS context GUCs are configured
  by Feature 001's migrations 0000 and 0001). Each test MAY skip
  applying later migrations if irrelevant, but MUST document why.
- The runtime DB role for RLS assertions is `app_test` (created by
  `applyAllUpAndCreateAppRole`). Tests MUST assert
  `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_test'` returns
  `false` before exercising any RLS policy (Constitution §2).
- Each test cleans up its own fixture data via the admin pool. No
  cross-test state leakage.
- Skip behavior: respect `MIGRATION_TEST_ALLOW_SKIP=1` as `migration_0001.spec.ts`
  does (see `migration_0001.spec.ts:51`). CI MUST NOT set this variable.

## 6. T326 — Forward migration applies cleanly + creates seven tables, indexes, RLS, CHECKs, partial UQ indexes

`tasks.md §5.3` defines T326 as: "Test that no catalog table exists on a
clean Postgres before the migration runs and that all seven tables,
indexes, RLS policies, CHECK constraints, and partial unique indexes exist
after migration." This is the single largest test in the suite.

### 6.1 Pre-migration assertions (clean Postgres)

Boot a fresh container, apply migrations `0000`–`0005` only (skipping the
catalog migration), and assert:

- The seven catalog tables MUST NOT exist:
  - `SELECT to_regclass('public.global_products') IS NULL`
  - `SELECT to_regclass('public.tenant_products') IS NULL`
  - `SELECT to_regclass('public.tenant_product_categories') IS NULL`
  - `SELECT to_regclass('public.store_product_overrides') IS NULL`
  - `SELECT to_regclass('public.product_aliases') IS NULL`
  - `SELECT to_regclass('public.price_history') IS NULL`
  - `SELECT to_regclass('public.unknown_items') IS NULL`
- The new column on `tenants` MUST NOT yet exist:
  - `SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'default_currency_code'` returns zero rows
    (per `data-model.md §13`).

### 6.2 Apply the catalog migration

Read the migration SQL text from `packages/db/drizzle/<resolved-name>.sql`
(see §5 and §16-R2 for the naming reconciliation) and apply it via the
admin pool. Mirrors `migration_0001.spec.ts` line 47 / lines 444-453.

### 6.3 Post-migration table-existence assertions

- All seven `to_regclass(...)` queries return non-null.
- The Drizzle migration tracker row exists:
  `SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = <expected-hash>`
  (or whatever tracker convention `migration.spec.ts` uses — confirm
  against existing test code in the implementation PR).
- `tenants.default_currency_code` column now exists with `data_type = 'character'`,
  `character_maximum_length = 3`, `is_nullable = 'NO'`, `column_default = 'USD'::bpchar`
  (or equivalent). Per `data-model.md §13`.

### 6.4 Column-level assertions per table

For every table, every column declared in `data-model.md §2-§8` is present
with the right type and nullability. Concretely, for each table run:

```sql
SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale,
       character_maximum_length, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = $1
ORDER BY ordinal_position
```

Then assert the column set against the `data-model.md` table. Specific
assertions:

- All `uuid` PK columns: `data_type = 'uuid'`, `is_nullable = 'NO'`,
  default contains `gen_random_uuid()` (or equivalent).
- All `timestamptz` columns: `data_type = 'timestamp with time zone'`.
  `created_at` and `updated_at` are `NOT NULL DEFAULT now()`.
- All `tenant_id` / `store_id` columns: `uuid NOT NULL`.
- `numeric` money columns (eight total — see §9.1 for the list):
  `data_type = 'numeric'`, `numeric_precision = 19`, `numeric_scale = 4`.
- `char(3)` currency columns: `data_type = 'character'`,
  `character_maximum_length = 3`.
- `text` columns where `data-model.md` says NOT NULL: `is_nullable = 'NO'`.
- `jsonb` columns (`unknown_items.sale_context`): `data_type = 'jsonb'`,
  `is_nullable = 'YES'`.

### 6.5 RLS policy inventory (per table)

See §10 for the full RLS inventory expected on every catalog table. T326
MUST assert every entry in §10. Per-table assertions:

- `SELECT relrowsecurity FROM pg_class WHERE relname = '<table>'` is
  `true` for all seven tables.
- `SELECT relforcerowsecurity FROM pg_class WHERE relname = '<table>'` is
  `true` for all seven tables (Constitution §2 fail-closed).
- `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = '<table>'`
  returns the expected per-table policies listed in `data-model.md §2-§8`
  and in `rls-test-matrix.md`.
- For every write-side policy: `with_check IS NOT NULL`.
- `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_test'` is
  `false` (Constitution §2).

### 6.6 Index inventory (per table)

See §11 for the full index list. T326 MUST assert every entry. For each
expected index name `<idx>`:

```sql
SELECT pi.indexrelid::regclass::text AS name,
       pi.indisunique,
       pg_get_expr(pi.indpred, pi.indrelid) AS predicate,
       pg_get_indexdef(pi.indexrelid) AS def
FROM pg_index pi
JOIN pg_class c ON c.oid = pi.indexrelid
WHERE c.relname = '<idx>'
```

Assertions:

- The query returns exactly one row.
- For partial indexes, `predicate` matches the expected `WHERE` clause
  (string-match against `data-model.md` expectation, normalized for
  PostgreSQL's canonical formatting).
- For unique indexes, `indisunique = true`.

### 6.7 CHECK constraint inventory (per table)

See §12 for the full CHECK list. For each expected CHECK name `<chk>`:

```sql
SELECT conname, contype, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname = '<chk>' AND contype = 'c'
```

Assertions:

- Exactly one row.
- `def` contains the expected predicate (string-match, allowing for
  PostgreSQL's canonical normalization — e.g., `length(name)` vs
  `char_length(name)`; the implementation PR fixes the migration to match
  the assertion or vice versa).

### 6.8 Foreign key inventory

For every FK declared in `data-model.md §2-§9`:

```sql
SELECT c.conname, c.confdeltype, c.confupdtype,
       cf.relname AS ref_table
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class cf ON cf.oid = c.confrelid
WHERE t.relname = '<table>' AND c.contype = 'f'
ORDER BY c.conname
```

Assert each expected FK exists and has the correct `confdeltype`:

- `'a'` = `NO ACTION` (default) — for most tenant-scoped FKs.
- `'r'` = `RESTRICT` — for `tenant_products.tenant_id`,
  `store_product_overrides.product_id`, `product_aliases.product_id`,
  `price_history.product_id`. Per `data-model.md §9` cascade table.
- `'n'` = `SET NULL` — for `tenant_products.category_id` and
  `unknown_items.resolved_product_id`. Per `data-model.md §9`.
- `'c'` = `CASCADE` — **MUST NOT** appear for any catalog FK
  (Constitution §3 / data integrity; see also Q5 / T328).

`tenant_products.source_global_product_id` MUST NOT appear in this query
because there is no FK at all (see §8 / Q5).

## 7. T327 — Rollback restores pre-migration state

`tasks.md §5.3` defines T327 as: "Test that rollback
(`0001_catalog.down.sql`) removes everything T326 verified, leaving
Postgres in the pre-migration state."

### 7.1 Rollback application

After T326's post-migration assertions pass, apply the rollback SQL
(`<resolved-name>.down.sql`).

### 7.2 Post-rollback assertions

- All seven catalog tables MUST be absent:
  - `SELECT to_regclass('public.global_products') IS NULL`
  - …same for the other six.
- `tenants.default_currency_code` MUST be absent (rollback removes the
  Phase 2 column on `tenants` per `data-model.md §13`).
- No orphan indexes:
  - `SELECT count(*) FROM pg_indexes WHERE tablename IN ('global_products', 'tenant_products', 'tenant_product_categories', 'store_product_overrides', 'product_aliases', 'price_history', 'unknown_items')`
    returns `0`.
- No orphan CHECK / FK / UQ constraints:
  - `SELECT count(*) FROM pg_constraint WHERE conrelid::regclass::text IN ('global_products', ...)`
    returns `0`. (Each `regclass` cast will throw if the table is absent —
    use `to_regclass` and filter `NOT NULL` first.)
- No orphan RLS policies:
  - `SELECT count(*) FROM pg_policies WHERE tablename IN (...)` returns `0`.
- The Drizzle migration tracker row is removed (or marked rolled-back per
  whatever convention the existing tracker uses).

### 7.3 UP -> DOWN -> UP cycle (idempotent forward migration)

After the rollback, re-apply the catalog migration. All §6.3–§6.8
assertions MUST pass again. This is the same pattern as
`migration_0001.spec.ts:440-496`.

### 7.4 Down-then-up ordering note

Where downstream Feature 001 migrations depend on Phase 1 objects, the
rollback test MAY need to roll back later migrations first (see
`migration_0001.spec.ts:447-449` for the precedent: "0002_shifts depends
on devices … Drop 0002 first so 0001 DOWN can remove devices without a FK
violation"). For T327, the catalog migration is the **last** migration in
lex order, so no later migration needs to be rolled back first. If the
implementation PR adds a Feature 003 follow-up migration before T330
lands, this assumption must be revisited.

## 8. T328 — No cascading FK from tenant_products to global_products (Q5)

`tasks.md §5.3`: "Test that no foreign key from `tenant_products` to
`global_products` has `ON UPDATE CASCADE` or `ON DELETE CASCADE`."

### 8.1 Primary-source clarification (Q5)

`data-model.md §3` and §11 (the "Why `source_global_product_id` has no FK"
subsection) state explicitly: **there is no FK at all** between
`tenant_products.source_global_product_id` and `global_products.id`. The
column is a soft provenance reference. Quote from `data-model.md §3`:

> `source_global_product_id` is a provenance reference only … No FK is
> declared because a FK (even without `ON DELETE CASCADE`) would create a
> hard dependency between platform-side global product lifecycle and
> tenant data.

The strictest reading of "no FK has CASCADE" is therefore "no FK exists".
T328 asserts both:

### 8.2 Primary assertion — no FK exists

```sql
SELECT c.conname, c.confdeltype, c.confupdtype
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class cf ON cf.oid = c.confrelid
WHERE t.relname = 'tenant_products'
  AND cf.relname = 'global_products'
  AND c.contype = 'f'
```

Expected: zero rows. Per `data-model.md §3` (Q5 / spec §5.1
copy-on-adopt-snapshot).

### 8.3 Secondary assertion — `source_global_product_id` is a soft reference

The column exists as `uuid NULL` with no FK constraint:

```sql
SELECT data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'tenant_products' AND column_name = 'source_global_product_id'
```

Expected: `data_type = 'uuid'`, `is_nullable = 'YES'`. Per `data-model.md §3`.

### 8.4 Behavioral assertion — orphan reference is permitted

After seeding a `global_products` row and a `tenant_products` row with
matching `source_global_product_id`, hard-delete the `global_products`
row and assert the `tenant_products` row remains intact with its
`source_global_product_id` still pointing to the now-missing UUID. This
exercises the copy-on-adopt-snapshot guarantee: a platform-side delete
must not cascade or constrain tenant data.

```sql
DELETE FROM global_products WHERE id = $1;
SELECT id, source_global_product_id FROM tenant_products WHERE id = $2;
```

Expected: the second query returns one row; `source_global_product_id`
equals the deleted UUID; no FK error was raised.

### 8.5 Safety net — no FK in either direction

The test also runs the §8.2 query with `t.relname` and `cf.relname`
swapped (i.e., a hypothetical FK from `global_products` to
`tenant_products`). Expected: zero rows. There is no architectural reason
this FK would exist, but the assertion is cheap and catches accidental
mis-direction.

### 8.6 What this test must NOT do

- MUST NOT assert that a CASCADE FK is absent if it is asserting an FK
  exists. Per §8.2, no FK exists at all — the prompt's
  "`confdeltype` returns `'a'` or `'r'`" framing is incorrect for Q5.
- MUST NOT assert anything about `tenant_products.tenant_id ->
  tenants(id)` cascade behavior here. That belongs in T326's FK
  inventory (§6.8).

## 9. T329 — Numeric money type + non-negative CHECK on every money column (Q1)

`tasks.md §5.3`: "Test that every `numeric` column with money semantics is
`numeric(19,4)` and has a `CHECK (... >= 0)` constraint."

### 9.1 Money column inventory (Q1)

Every column that stores a monetary amount, drawn from `data-model.md`:

| Table | Column | Nullable | Source |
|---|---|---|---|
| `global_products` | `default_price` | YES | `data-model.md §2` |
| `tenant_products` | `default_price` | YES | `data-model.md §3` |
| `store_product_overrides` | `price` | YES | `data-model.md §5` |
| `price_history` | `price` | NO | `data-model.md §7` |

The `cost_price` / `sale_price_override` columns mentioned in the Lane C
prompt do not appear in `data-model.md`. The authoritative list above is
canonical. If the implementation PR adds additional money columns
(e.g., during code review), they MUST be appended to this list and the
test MUST be updated.

### 9.2 Type assertions

For each money column, run:

```sql
SELECT data_type, numeric_precision, numeric_scale, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = $1
  AND column_name = $2
```

Assert:

- `data_type = 'numeric'`. Test fails if `data_type IN ('double precision',
  'real', 'integer', 'bigint')`.
- `numeric_precision IS NOT NULL` (guard against unbounded `numeric`).
- `numeric_precision = 19`.
- `numeric_scale = 4`.
- `is_nullable` matches the expected value in §9.1.

### 9.3 Non-negative CHECK assertions

For each money column, assert that a corresponding `CHECK (column >= 0)`
constraint exists. Per `data-model.md`, the named constraints are:

- `price_history.price` → `CHK price_history_price_positive` (data-model.md §7).
- The other three money columns (`global_products.default_price`,
  `tenant_products.default_price`, `store_product_overrides.price`) do
  not have named non-negative CHECK constraints declared in
  `data-model.md` as of 2026-05-16. T329 is the gate that **requires the
  migration to add them**. Per `tasks.md §5.3` T329 wording: "every
  numeric column with money semantics … has a CHECK (... >= 0)
  constraint."

  The expected constraint names (subject to the implementation PR's
  naming convention) are:
  - `global_products_default_price_non_negative`
  - `tenant_products_default_price_non_negative`
  - `store_product_overrides_price_non_negative`

  These names MUST be authored in T330's migration. The implementation
  PR MUST update `data-model.md §2/§3/§5` to declare these CHECK
  constraints alongside the migration, since T329 is a primary-source
  gate for them. See §17-Q2.

Per-column assertion:

```sql
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = '<table>'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%' || $1 || '%>=%0%'
```

Test fails if no row matches for any money column.

### 9.4 Behavioral assertion — negative price rejected

For each money column, attempt to insert a row with the column set to
`-0.01`. The INSERT MUST fail with an error whose message matches
`/_non_negative|_positive|check constraint/i`. This is the live exercise
of the predicate, matching `migration_0001.spec.ts:103-113` precedent
(checking CHECK behavior with a real INSERT).

### 9.5 Currency-pairing companion assertion (Q2)

While T329's mandate is Q1 (money type / non-negative), Q2 (paired
currency) is enforced by named CHECK constraints in `data-model.md`
(`global_products_currency_paired`, `tenant_products_currency_paired`,
`store_product_overrides_currency_paired`). Those CHECKs belong in T326's
CHECK inventory (§12), not T329. T329 does not re-assert them.

`price_history.currency_code` is `NOT NULL` (per `data-model.md §7`), so
there is no Q2 CHECK needed there — the NOT NULL constraint plus the
NOT NULL on `price_history.price` together guarantee both fields are
populated.

## 10. Cross-cutting RLS inventory expectations

Asserted by T326 §6.5. Per `data-model.md §10` and `rls-test-matrix.md`:

| Table | RLS enabled | FORCE RLS | Policies |
|---|---|---|---|
| `global_products` | YES | YES | `global_products_read` (SELECT, qual `TRUE`); `global_products_platform_write` (INSERT/UPDATE/DELETE, qual + check `current_setting('app.current_role') = 'platform_admin'`) |
| `tenant_products` | YES | YES | `tenant_products_tenant_isolation` (SELECT, qual `tenant_id = current_setting('app.current_tenant')::uuid`); `tenant_products_tenant_write` (INSERT/UPDATE/DELETE, qual + check same) |
| `tenant_product_categories` | YES | YES | `tenant_product_categories_tenant_isolation` (SELECT); `tenant_product_categories_tenant_write` (INSERT/UPDATE/DELETE) |
| `store_product_overrides` | YES | YES | `store_product_overrides_tenant_isolation` (SELECT); `store_product_overrides_store_read` (SELECT, qual includes store + `current_setting('app.current_store') = ''` empty-string fallback for tenant-wide reads); `store_product_overrides_tenant_write` (INSERT/UPDATE/DELETE, qual + check scoped to tenant AND store) |
| `product_aliases` | YES | YES | `product_aliases_tenant_isolation` (SELECT); `product_aliases_tenant_write` (INSERT/UPDATE/DELETE) |
| `price_history` | YES | YES | `price_history_tenant_isolation` (SELECT); `price_history_tenant_insert` (INSERT only); `price_history_no_update_delete` (UPDATE/DELETE, qual + check `FALSE`) — immutability enforced at RLS layer per Constitution §13 |
| `unknown_items` | YES | YES | `unknown_items_tenant_isolation` (SELECT); `unknown_items_store_read` (SELECT, store-aware); `unknown_items_insert` (INSERT); `unknown_items_resolve` (UPDATE) |

Every write-side policy MUST have `with_check` non-NULL (matches
`migration_0001.spec.ts:235-248` pattern).

The runtime role assertion (Constitution §2):

```sql
SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_test'
```

MUST return `false`. If it returns `true`, the entire RLS test suite is
meaningless; T326 fails loudly.

## 11. Cross-cutting index inventory expectations

Asserted by T326 §6.6. Per `data-model.md §2-§8`:

### `global_products`

- `idx_global_products_active` — partial on `(id) WHERE retired_at IS NULL`.
- `idx_global_products_suggested_category` — partial on
  `(suggested_category) WHERE retired_at IS NULL`.

### `tenant_products`

- `idx_tenant_products_tenant_active` — partial on `(tenant_id, id) WHERE retired_at IS NULL`.
- `idx_tenant_products_tenant_category` — partial on `(tenant_id, category_id) WHERE retired_at IS NULL`.
- `idx_tenant_products_source_global` — partial on `(source_global_product_id) WHERE source_global_product_id IS NOT NULL`.

### `tenant_product_categories`

- `idx_tenant_product_categories_tenant_active` — partial on `(tenant_id) WHERE retired_at IS NULL`.
- `UQ_idx_tenant_product_categories_tenant_name` — partial UQ on `(tenant_id, name) WHERE retired_at IS NULL`.

### `store_product_overrides`

- `idx_store_product_overrides_store_active` — partial on `(tenant_id, store_id) WHERE retired_at IS NULL`.
- `idx_store_product_overrides_product` — partial on `(tenant_id, product_id) WHERE retired_at IS NULL`.
- `UQ_idx_store_product_overrides_product_store` — partial UQ on `(tenant_id, store_id, product_id) WHERE retired_at IS NULL`.

### `product_aliases` (Q4 — three partial UQ indexes)

- `UQ_idx_product_aliases_tenant_wide` — partial UQ on `(tenant_id, identifier_type, value) WHERE store_id IS NULL AND identifier_type <> 'external_pos_id' AND retired_at IS NULL`.
- `UQ_idx_product_aliases_external_pos_id` — partial UQ on `(tenant_id, source_system, value) WHERE identifier_type = 'external_pos_id' AND retired_at IS NULL`.
- `UQ_idx_product_aliases_store_scoped` — partial UQ on `(tenant_id, store_id, identifier_type, value) WHERE store_id IS NOT NULL AND retired_at IS NULL`.
- `idx_product_aliases_lookup` — partial on `(tenant_id, identifier_type, value) WHERE retired_at IS NULL`.
- `idx_product_aliases_product` — partial on `(tenant_id, product_id) WHERE retired_at IS NULL`.

### `price_history` (Q9)

- `UQ_idx_price_history_tenant_open` — partial UQ on `(tenant_id, product_id) WHERE store_id IS NULL AND effective_to IS NULL` (at most one open tenant-level interval per product).
- `UQ_idx_price_history_store_open` — partial UQ on `(tenant_id, product_id, store_id) WHERE store_id IS NOT NULL AND effective_to IS NULL`.
- `idx_price_history_product_timeline` on `(tenant_id, product_id, effective_from DESC)`.
- `idx_price_history_store_timeline` — partial on `(tenant_id, product_id, store_id, effective_from DESC) WHERE store_id IS NOT NULL`.

Note: `data-model.md §7` enforces open-interval uniqueness via **partial
unique B-tree indexes**, not via an `EXCLUDE USING GIST … tstzrange(...)`
constraint. The Lane C prompt's GIST EXCLUDE recommendation is contrary
to `data-model.md` and should NOT be implemented. See §16-R4.

### `unknown_items`

- `idx_unknown_items_pending` — partial on `(tenant_id, store_id) WHERE resolution_status = 'pending'`.
- `idx_unknown_items_lookup_value` — partial on `(tenant_id, identifier_type, value) WHERE resolution_status = 'pending'`.
- `idx_unknown_items_encountered_at` on `(tenant_id, encountered_at DESC)`.

### Negative index assertions

- No index over PII columns. Cross-check against `redaction-matrix.md` —
  no catalog column is currently classified as PII, but if the
  implementation PR introduces one (e.g., supplier contact details), T326
  MUST exclude it from any indexable column list.
- No globally-unique index over an alias `value` (cardinality leakage
  across tenants would let an external attacker probe alias namespaces).
  Per Q4, all three alias UQ indexes are scoped to `tenant_id`.

## 12. Cross-cutting CHECK constraint inventory expectations

Asserted by T326 §6.7. Per `data-model.md §2-§8`:

### `global_products`

- `global_products_name_length`: `length(name) BETWEEN 1 AND 500`.
- `global_products_currency_paired`: `(default_price IS NULL AND default_currency_code IS NULL) OR (default_price IS NOT NULL AND default_currency_code IS NOT NULL)`. Q2.
- `global_products_suggested_tax_category_format`: `suggested_tax_category IS NULL OR (length(suggested_tax_category) BETWEEN 1 AND 50)`. Q11.
- `global_products_default_price_non_negative` (NEW per T329 §9.3): `default_price IS NULL OR default_price >= 0`. Q1.

### `tenant_products`

- `tenant_products_name_length`: `length(name) BETWEEN 1 AND 500`.
- `tenant_products_currency_paired`. Q2.
- `tenant_products_tax_category_length`: `length(tax_category) BETWEEN 1 AND 50`. Q11.
- `tenant_products_default_price_non_negative` (NEW per T329 §9.3). Q1.

### `tenant_product_categories`

- `tenant_product_categories_name_length`: `length(name) BETWEEN 1 AND 200`.
- No `parent_category_id != id` self-loop CHECK because there is no
  `parent_category_id` column (Q7 deferred). Lane C prompt mention of
  such a CHECK is incorrect; do not author it.

### `store_product_overrides`

- `store_product_overrides_currency_paired`. Q2.
- `store_product_overrides_tax_category_length`. Q11.
- `store_product_overrides_at_least_one_override`: `NOT (price IS NULL AND is_active IS NULL AND tax_category IS NULL)`.
- `store_product_overrides_price_non_negative` (NEW per T329 §9.3). Q1.

### `product_aliases`

- `product_aliases_identifier_type_valid`: `identifier_type IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')`.
- `product_aliases_value_length`: `length(value) BETWEEN 1 AND 200`.
- `product_aliases_source_system_required`: scope-conditional pairing of `identifier_type = 'external_pos_id'` and `source_system IS NOT NULL`. Per Constitution §11.
- `product_aliases_store_scope_consistency`: `store_id IS NULL OR identifier_type <> 'external_pos_id'`.

### `price_history`

- `price_history_interval_order`: `effective_to IS NULL OR effective_to > effective_from`. Q9.
- `price_history_price_positive`: `price >= 0`. Q1.

### `unknown_items`

- `unknown_items_identifier_type_valid`.
- `unknown_items_value_length`.
- `unknown_items_resolution_status_valid`.
- `unknown_items_resolution_action_valid`.
- `unknown_items_resolved_fields_consistent`: pending-vs-resolved field tri-state. Q10.
- `unknown_items_linked_product_present`.
- `unknown_items_source_system_required`.

### Cross-entity CHECKs

- `tenant_id` matching between `store_product_overrides` and
  `tenant_products` (where applicable). `data-model.md §5` does not
  declare this as a CHECK on `store_product_overrides`; instead, the
  Tenant Catalog write enforces it via the application service. The
  Lane C prompt's Q11 framing of a denormalized composite FK to
  `tenant_products(id, tenant_id)` is **not** specified in
  `data-model.md` — implementing it would require amending the data
  model. T326 MUST NOT assert this composite FK exists until
  `data-model.md` declares it. See §17-Q3.

## 13. Test fixture strategy

- Each top-level `describe` block creates its own tenant + store(s) +
  category + a small number of `tenant_products` rows via direct INSERT
  using the **admin pool** (superuser bypasses RLS). The admin pool is
  the right choice for fixture setup; switch to the `app_test` pool only
  for RLS-bound behavioral assertions.
- Use stable UUID literals (e.g., `0e000000-0000-7000-8000-...` pattern
  per `migration_0001.spec.ts:516-519`) so DELETEs at test start are
  deterministic and idempotent.
- Fixtures are minimal:
  - One tenant.
  - One store.
  - One category.
  - One `global_products` row.
  - Two `tenant_products` rows (one adopted from global, one created
    directly).
  - One `store_product_overrides` row.
  - One `product_aliases` row per identifier_type the test exercises.
  - Two `price_history` rows (one closed interval, one open interval).
- Do NOT invent new fixture helpers in this lane. The existing
  `_helpers/postgres-container.ts` exposes `applyAllUpAndCreateAppRole`
  which is sufficient for migration tests. If T326–T329 require a new
  `seedCatalogFixture(env)` helper, the implementation PR adds it to
  `_helpers/` alongside the test file.
- Each `it()` MUST clean up its own data so test order does not matter:
  `DELETE FROM <table> WHERE id = ANY($1::uuid[])` for each fixture
  table at the top of the test (matches `migration_0001.spec.ts:106`).

## 14. Relationship to T330 migration implementation

- T326–T329 tests pair naturally with T330 (the migration that creates the
  catalog tables and its rollback).
- The §5.3 DAG predecessor order is: T320 / T331 must be approved first;
  then T326–T329 are authored against the as-yet-unwritten migration;
  then T330 authors the migration to make the tests pass.
- **Recommended packaging**: bundle T320 + T331 + T326–T329 + T330 into
  **one** PR titled
  `feat(db): add catalog foundation schema, barrel, migration 0006_catalog + tests (003 T320, T326–T331)`.
  Rationale:
  - Reviewer sees the migration and the tests that validate it in one
    diff.
  - The five `[GATED]` tasks (T320, T331, T330) get a single approval
    gate instead of three.
  - The naming reconciliation in §5 / §16-R2 is resolved once, not three
    times.
- **Alternative packaging**: split T320 + T331 into one PR (schema source
  and barrel only, no migration), and T326–T329 + T330 into a second PR
  (tests + migration). This adds one PR cycle but reduces diff size.
- The implementation PR MUST run, before opening the PR:
  - `pnpm --filter @datapulse/db typecheck`
  - `pnpm --filter @datapulse/db lint`
  - `pnpm --filter @datapulse/db test -- migration_catalog`
  - `pnpm --filter @datapulse/db test -- rls.bypass`
  All four must pass on a clean container.

## 15. Out-of-scope (explicit non-goals)

- POS read-model tests (see `pos-read-model-direction.md` — future
  feature, deferred per spec §5.5).
- Catalog API controller / service tests (T340–T540 in `tasks.md`).
- Catalog OpenAPI contract tests (T490+ in `tasks.md`).
- Anything in `specs/004-platform-production-readiness/**`.
- The SaleLine snapshot table — concept-only per `data-model.md §12`; no
  schema is authored in Phase 2.
- The variants schema (`parent_product_id`, `variant_group_id`) — Q6
  deferred per `data-model.md §11`.

## 16. Risks and mitigations

### 16-R1. The Lane C prompt's T329 framing contradicts `data-model.md §3` for Q5

The prompt says T329 (in its framing) should assert the FK
`tenant_products.global_product_id` references `global_products(id)` with
`ON DELETE NO ACTION` or `RESTRICT`. Per `data-model.md §3`, there is no
such FK at all — and `data-model.md` is the primary source of truth
(spec §16 lists Q5 as resolved to copy-on-adopt snapshot with explicit
"No FK constraint" wording, repeated in `data-model.md §3`).

**Mitigation**: this plan follows `data-model.md`. T328 asserts the
**absence** of any FK between the two tables, plus the soft-reference
behavior (§8.2-§8.4). If the implementation PR disagrees, escalate to
the spec owner before authoring the migration.

### 16-R2. Migration filename conflict

`tasks.md §5.3` specifies `packages/db/drizzle/0001_catalog.sql`. That
name is **already taken** by `0001_pos_operator_identity.sql`. The next
free lex-ordered number is **0006**, so the catalog migration must be
named `0006_catalog.sql` (rollback `0006_catalog.down.sql`).

**Mitigation**: the implementation PR (T330) authors the migration at
the resolved name, and amends `tasks.md §5.3` to reference the new
name in a single targeted edit. Tests resolve the migration path via
the helper's `DRIZZLE_DIR` constant (per `_helpers/postgres-container.ts:21`),
so the test code paths only need to reference the final filename in
one or two places.

### 16-R3. Test file path conflict

`tasks.md §5.3` says T326 lives at
`packages/db/__tests__/migration/0001-catalog.spec.ts` (new
`migration/` subdirectory). Existing convention has all migration tests
at `packages/db/__tests__/migration_NNNN.spec.ts` (no subdirectory).
Two paths are in tension.

**Mitigation**: this plan recommends `packages/db/__tests__/migration_catalog.spec.ts`
(matches existing convention, deviates from `tasks.md`'s proposal). The
implementation PR picks one and amends `tasks.md` if it picks the
non-conventional path.

### 16-R4. EXCLUDE USING GIST is NOT the chosen approach for price-history open intervals

The Lane C prompt recommended asserting an `EXCLUDE USING GIST` constraint
with `tstzrange(effective_from, COALESCE(effective_to, 'infinity'))` on
`price_history`. **`data-model.md §7` explicitly uses partial unique
B-tree indexes**, not an EXCLUDE constraint:

```
UQ_idx_price_history_tenant_open
  ON price_history (tenant_id, product_id)
  WHERE store_id IS NULL AND effective_to IS NULL
```

**Mitigation**: T328's EXCLUDE assertion is **dropped**. T326's index
inventory (§11 — `price_history` section) asserts the two partial UQ
B-tree indexes per `data-model.md §7`. If the implementation PR wants
to switch to GIST EXCLUDE, `data-model.md §7` must be amended first.

### 16-R5. Test helper `app_test` role assumption

The plan assumes `_helpers/postgres-container.ts` creates `app_test` as
a non-superuser without `BYPASSRLS`. This is verified by reading
`postgres-container.ts:24-26` (`APP_ROLE_NAME = "app_test"`). If a
future helper change adds `BYPASSRLS` for any reason, T326's
`rolbypassrls = false` assertion fails loudly — which is the correct
behavior.

### 16-R6. `numeric` column metadata can be misleading

Postgres treats `decimal` and `numeric` synonymously in
`information_schema.columns.data_type` (both report `'numeric'`).
Unbounded `numeric` columns report `numeric_precision IS NULL`. T329's
guard `numeric_precision IS NOT NULL` catches this; without it, an
unbounded `numeric` column would silently pass the `(p, s)` check
because both fields are NULL.

### 16-R7. `data-model.md` does not declare non-negative CHECKs for three of four money columns

T329's mandate per `tasks.md §5.3` is to assert that every money column
has a `CHECK (... >= 0)`. Only `price_history.price_positive` is
declared in `data-model.md` today (§7). The other three money columns
need new named CHECKs in T330's migration AND a corresponding
`data-model.md` update.

**Mitigation**: see §9.3 and §17-Q2. The implementation PR adds the
three new CHECKs to both the migration AND `data-model.md` in a single
diff.

### 16-R8. Lane C prompt mentions columns / constraints that do not exist in `data-model.md`

The prompt mentions `cost_price`, `sale_price`, `sale_price_override`,
`raw_sku`, `parent_category_id != id` CHECK, `tenant_id` composite FK
on `store_product_overrides`, and an EXCLUDE GIST constraint. None of
these appear in `data-model.md`. Implementing assertions for them
would require amending `data-model.md` first.

**Mitigation**: this plan ignores those items and surfaces them in §17
as open questions. Following `data-model.md` keeps the test plan
consistent with the primary source.

## 17. Open questions for the implementation PR

- **17-Q1**. Confirm the migration filename. `0006_catalog.sql` is the
  proposed resolution per §5 / §16-R2.
- **17-Q2**. Confirm the three new non-negative CHECK constraint names on
  `global_products`, `tenant_products`, `store_product_overrides`. Per
  §9.3 / §12 / §16-R7. Suggested names:
  - `global_products_default_price_non_negative`
  - `tenant_products_default_price_non_negative`
  - `store_product_overrides_price_non_negative`
- **17-Q3**. Does T330's migration enforce
  `store_product_overrides.tenant_id == tenant_products.tenant_id` via a
  composite FK, a CHECK constraint, or only at the application layer?
  `data-model.md §5` is silent on this. If a DB-level constraint is
  added, T326's FK / CHECK inventory MUST be updated accordingly.
- **17-Q4**. Confirm test file naming convention: amend `tasks.md §5.3`
  to either `migration_catalog.spec.ts` (existing convention) or
  `migration/0006-catalog.spec.ts` (new subdirectory). See §16-R3.
- **17-Q5**. Confirm whether T327 lives in the same `.spec.ts` file as
  T326 (recommended, matches `migration_0001.spec.ts:440-496`) or in
  a sibling file (`migration_catalog_rollback.spec.ts`).

---

**End of plan.** This document is the only deliverable from Lane C in
PR-cycle 2026-05-16. No executable tests, no migration SQL, no schema
source, no barrel changes, no contract changes.
