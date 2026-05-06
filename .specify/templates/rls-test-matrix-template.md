# RLS Test Matrix: [Table / Feature Name]

**Ref**: [spec-id or task ID]
**Author**: [name or role]
**Date**: YYYY-MM-DD
**Constitution**: vX.Y.Z

---

## Tables Covered

| Table | Policy name | Policy type | Applies to |
|---|---|---|---|
| `table_name` | `policy_name` | PERMISSIVE / RESTRICTIVE | SELECT / INSERT / UPDATE / DELETE / ALL |

*(List each table and each policy separately. If a table has multiple
policies, add one row per policy.)*

---

## Test Scenarios

Each scenario maps to one or more test IDs in the test file listed under
Implementation Pointers. The test IDs follow the pattern `T-RLS-NNN`.

### 1. Own-Tenant Access — Baseline

| Actor | GUC `app.current_tenant` | Operation | Expected result | Test ID |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | SELECT | rows returned | T-RLS-001 |
| Tenant A principal | Tenant A UUID | INSERT | success | T-RLS-002 |
| Tenant A principal | Tenant A UUID | UPDATE | success | T-RLS-003 |
| Tenant A principal | Tenant A UUID | DELETE | success | T-RLS-004 |

### 2. Cross-Tenant Probe — Isolation (Principle II)

| Actor | GUC `app.current_tenant` | Target row owner | Operation | Expected result | Test ID |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows | T-RLS-005 |
| Tenant A principal | Tenant A UUID | Tenant B | UPDATE | 0 rows affected | T-RLS-006 |
| Tenant A principal | Tenant A UUID | Tenant B | DELETE | 0 rows affected | T-RLS-007 |

### 3. Unset GUC — Fail-Closed (Principle II)

Verifies the `current_setting('app.current_tenant', true)` safe form
returns NULL when the GUC is unset, matching no rows.

| GUC state | Operation | Expected result | Test ID |
|---|---|---|---|
| NULL / unset | SELECT | 0 rows | T-RLS-008 |
| NULL / unset | INSERT | policy block / 0 rows | T-RLS-009 |

### 4. Wrong-Tenant Bypass Probe — Raw SQL (Principle VI)

A raw SQL query sets the GUC to a wrong tenant UUID and asserts the table
returns zero rows for that tenant's data. This is an integration test
against a real Postgres instance (Testcontainers).

| Scenario | SQL pattern (representative) | Expected result | Test ID |
|---|---|---|---|
| Raw SQL, wrong-tenant GUC | `SET LOCAL app.current_tenant = '<wrong-uuid>';`<br>`SELECT * FROM table_name;` | 0 rows | T-RLS-010 |

### 5. Platform-Admin Cross-Tenant (if applicable)

Complete this section only when the table's policy includes a platform-admin
bypass branch. Delete the section entirely if the table has no platform-admin
path.

| Actor | GUC additions | Operation | Expected result | Test ID |
|---|---|---|---|---|
| Platform admin | `app.is_platform_admin = true` | SELECT all tenants | rows from all tenants returned | T-RLS-011 |
| Platform admin action | `app.is_platform_admin = true` | SELECT Tenant A | Tenant A rows only | T-RLS-012 |

### 6. Store-Scoped Sub-Matrix (if table carries `store_id`)

Complete this section only when the table is store-scoped and the policy
enforces `store_id` isolation in addition to `tenant_id`. Delete the section
entirely if the table has no store-scope requirement.

Repeat the own-store / cross-store / unset-store pattern following the same
structure as Scenarios 1–4 above.

| Actor | GUC `app.current_store` (or equivalent) | Target row | Operation | Expected result | Test ID |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Store X UUID | Store X row | SELECT | rows returned | T-RLS-013 |
| Tenant A / Store X principal | Store X UUID | Store Y row | SELECT | 0 rows | T-RLS-014 |

---

## Malicious-Override Probe (Principle XII)

Verifies that `tenant_id`, `store_id`, and other security-sensitive fields
in a write request body are ignored by the server, never honored.

| Injected field | Injected value | Expected outcome | Test ID |
|---|---|---|---|
| `tenant_id` in request body | Foreign tenant UUID | Field ignored; row created under active tenant | T-RLS-015 |
| `store_id` in request body | Out-of-scope store UUID | Field ignored / rejected | T-RLS-016 |

*(Add rows for any other security-sensitive fields relevant to this entity.
Delete this section only if the entity has no write endpoints.)*

---

## Implementation Pointers

- Test file: [path — e.g., `apps/api/src/[module]/[module].rls.spec.ts`]
- RLS policy migration: [migration file path]
- GUC helper utility: [path to the helper that sets `app.current_tenant`, or "TBD"]
- Testcontainers setup: [path to the shared Postgres test harness, or "shared — see `test/setup.ts`"]

---

> **When to use this template**
> Fill this when adding a new tenant-scoped table with an RLS policy, or
> when changing an existing RLS policy (column, condition, or scope change).
> Reference the filled matrix as the pointer in the Architecture Impact Map's
> DB gate: "RLS / tenant-context strategy required." Link it from the spec's
> test strategy section if it has one.
>
> **When NOT to use this template**
> Platform-admin tables explicitly designated as non-tenant-scoped with a
> documented justification. Non-Postgres data stores (Redis keys, object
> storage). Test-only or documentation-only PRs. Tables whose RLS policy is
> unchanged and already covered by an existing matrix.
