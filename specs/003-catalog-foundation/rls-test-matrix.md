# RLS Test Matrix: Catalog Foundation

**Ref**: Feature 003 — `catalog-foundation` / Task T311
**Author**: Ahmed Shaaban
**Date**: 2026-05-16
**Constitution**: v3.0.0
**Status**: Planned — no tests exist yet. All scenarios are forward-looking
obligations. Verbs ("will assert", "must return") describe required test
behaviour, not current coverage.

---

## Tables Covered

| Table | Policy name | Policy type | Applies to |
|---|---|---|---|
| `global_products` | `global_products_read` | PERMISSIVE | SELECT |
| `global_products` | `global_products_platform_write` | PERMISSIVE | INSERT, UPDATE, DELETE |
| `tenant_products` | `tenant_products_tenant_isolation` | PERMISSIVE | SELECT |
| `tenant_products` | `tenant_products_tenant_write` | PERMISSIVE | INSERT, UPDATE, DELETE |
| `tenant_product_categories` | `tenant_product_categories_tenant_isolation` | PERMISSIVE | SELECT |
| `tenant_product_categories` | `tenant_product_categories_tenant_write` | PERMISSIVE | INSERT, UPDATE, DELETE |
| `store_product_overrides` | `store_product_overrides_tenant_isolation` | PERMISSIVE | SELECT |
| `store_product_overrides` | `store_product_overrides_store_read` | PERMISSIVE | SELECT |
| `store_product_overrides` | `store_product_overrides_tenant_write` | PERMISSIVE | INSERT, UPDATE, DELETE |
| `product_aliases` | `product_aliases_tenant_isolation` | PERMISSIVE | SELECT |
| `product_aliases` | `product_aliases_tenant_write` | PERMISSIVE | INSERT, UPDATE, DELETE |
| `price_history` | `price_history_tenant_isolation` | PERMISSIVE | SELECT |
| `price_history` | `price_history_tenant_insert` | PERMISSIVE | INSERT |
| `price_history` | `price_history_no_update_delete` | RESTRICTIVE | UPDATE, DELETE |
| `unknown_items` | `unknown_items_tenant_isolation` | PERMISSIVE | SELECT |
| `unknown_items` | `unknown_items_store_read` | PERMISSIVE | SELECT |
| `unknown_items` | `unknown_items_insert` | PERMISSIVE | INSERT |
| `unknown_items` | `unknown_items_resolve` | PERMISSIVE | UPDATE |

---

## Summary: per-table scenario coverage

The acceptance criteria for T311 require each catalog table to have rows
covering: (a) same-tenant read, (b) cross-tenant read denied, (c) same-store
override read, (d) cross-store override read denied, (e) raw-SQL probe
behaviour. Where a criterion does not apply to a table, the row is present
with an explicit "N/A — see note" entry rather than being silently omitted.

| Table | (a) Same-tenant read | (b) Cross-tenant read denied | (c) Same-store read | (d) Cross-store read denied | (e) Raw-SQL probe |
|---|---|---|---|---|---|
| `global_products` | §1 (policy: `TRUE`) | N/A — platform-wide, no tenant data; see §1 note | N/A — not store-scoped | N/A — not store-scoped | §1.5 |
| `tenant_products` | §2.1 | §2.2 | N/A — not store-scoped at RLS | N/A — not store-scoped at RLS | §2.4 |
| `tenant_product_categories` | §3.1 | §3.2 | N/A — not store-scoped at RLS | N/A — not store-scoped at RLS | §3.4 |
| `store_product_overrides` | §4.1 | §4.2 | §4.3 | §4.4 | §4.5 |
| `product_aliases` | §5.1 | §5.2 | N/A — store isolation is alias-resolution uniqueness, not RLS; see §5 note | N/A — see §5 note | §5.4 |
| `price_history` | §6.1 | §6.2 | N/A — store rows are readable by tenant with correct tenant GUC | N/A — not store-isolated at RLS (tenant owns price history for all their stores) | §6.4 |
| `unknown_items` | §7.1 | §7.2 | §7.3 | §7.4 | §7.5 |

---

## §1 — `global_products`

### Purpose

`global_products` is the Global Product Index: platform-wide reference data,
curated by Platform Admins. It carries **no `tenant_id` column**. RLS on this
table does not express tenant isolation; instead it enforces a
Platform-Admin-only write restriction and open read access for any
authenticated session.

The "cross-tenant" probe does not apply in the standard form: there is no
tenant-derived data in this table, and no cross-tenant leakage is possible via
a SELECT. The relevant probes are instead write-attempt denial (tenant principal
must not INSERT, UPDATE, or DELETE) and the raw-SQL bypass probe.

### §1.1 — Authenticated read (baseline)

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal (any role) | Tenant A UUID | SELECT active rows | Rows returned — `global_products_read` policy = `TRUE` for any authenticated session | T343 (planned) |
| Platform Admin principal | (any or unset) | SELECT all rows | Rows returned | T343 (planned) |

### §1.2 — Write denial for tenant principal

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | INSERT | Denied — `global_products_platform_write` policy rejects non-platform-admin sessions | T344 (planned) |
| Tenant A principal | Tenant A UUID | UPDATE | Denied | T344 (planned) |
| Tenant A principal | Tenant A UUID | DELETE | Denied | T344 (planned) |

### §1.3 — Platform Admin write allowed

| Actor | GUC `app.current_role` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Platform Admin | `app.current_role = 'platform_admin'` | INSERT | Succeeds | T365 (planned) |
| Platform Admin | `app.current_role = 'platform_admin'` | UPDATE | Succeeds | T365 (planned) |
| Platform Admin | `app.current_role = 'platform_admin'` | DELETE / retire | Succeeds (soft-delete) | T365 (planned) |

### §1.4 — Unset GUC — fail-closed on writes

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_role` unset | INSERT | Policy block — write rejected | T343 (planned) |
| `app.current_role` unset | SELECT | Rows returned (read policy is `TRUE` for authenticated sessions) | T343 (planned) |

### §1.5 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Runtime role (non-platform-admin), raw INSERT | `SET LOCAL app.current_role = ''; INSERT INTO global_products ...` | RLS denies write | T343 (planned) |
| Runtime role, raw SELECT | `SET LOCAL ...; SELECT * FROM global_products` | Rows returned (read is open) | T343 (planned) |

> **Note on cross-tenant criterion**: Criterion (b) "cross-tenant read denied"
> does not apply to `global_products` because the table contains no tenant-owned
> data. All authenticated sessions may read it by policy design. The meaningful
> isolation concern here is write-access denial for non-platform-admin sessions
> (§1.2), which serves the same security boundary function.

---

## §2 — `tenant_products`

### §2.1 — Own-tenant read (baseline)

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | SELECT own rows | Rows returned | T341 (planned) |
| Tenant A principal | Tenant A UUID | INSERT | Success; `tenant_id` resolved from GUC | T350 (planned) |
| Tenant A principal | Tenant A UUID | UPDATE own row | Success | T352 (planned) |
| Tenant A principal | Tenant A UUID | DELETE / retire own row | Success | T354 (planned) |

### §2.2 — Cross-tenant read denied

| Actor | GUC `app.current_tenant` | Target row owner | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows — safe non-disclosing response (same as 404) | T341 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | UPDATE | 0 rows affected | T341 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | DELETE | 0 rows affected | T341 (planned) |

### §2.3 — Unset GUC — fail-closed

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_tenant` unset / NULL | SELECT | 0 rows | T343 (planned) |
| `app.current_tenant` unset / NULL | INSERT | Policy block / 0 rows | T343 (planned) |

### §2.4 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Wrong-tenant GUC via raw SQL | `SET LOCAL app.current_tenant = '<tenant-b-uuid>'; SELECT * FROM tenant_products;` | Only Tenant B rows visible — confirms RLS operates on the GUC, not application checks | T343 (planned) |
| No tenant GUC via raw SQL | `SET LOCAL app.current_tenant = ''; SELECT * FROM tenant_products;` | 0 rows (fail-closed) | T343 (planned) |

### §2.5 — Malicious body-override probe (Constitution §12)

| Injected field | Injected value | Expected outcome | Task anchor |
|---|---|---|---|
| `tenant_id` in request body | Foreign tenant UUID | Field rejected by Zod `.strict()` DTO; row created under active tenant from GUC | T344, T356 (planned) |
| `source_global_product_id` in request body | Arbitrary UUID | Field rejected by Zod `.strict()` DTO | T344, T356 (planned) |
| `created_by` in request body | Arbitrary UUID | Field rejected | T344, T356 (planned) |

> **Note on store-scoped criteria**: Criteria (c) "same-store override read"
> and (d) "cross-store override read denied" do not apply to `tenant_products`
> — this table has no `store_id` column and no store-level RLS policy. Store-
> level deviation from the Tenant Catalog is the responsibility of
> `store_product_overrides` (§4).

---

## §3 — `tenant_product_categories`

### §3.1 — Own-tenant read (baseline)

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | SELECT own rows | Rows returned | T341 (planned) |
| Tenant A principal | Tenant A UUID | INSERT | Success | T350 (planned, via category create path) |
| Tenant A principal | Tenant A UUID | UPDATE | Success | T353 (planned) |
| Tenant A principal | Tenant A UUID | DELETE / retire | Success | T355 (planned) |

### §3.2 — Cross-tenant read denied

| Actor | GUC `app.current_tenant` | Target row owner | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows — safe non-disclosing response | T341 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | UPDATE | 0 rows affected | T341 (planned) |

### §3.3 — Unset GUC — fail-closed

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_tenant` unset / NULL | SELECT | 0 rows | T343 (planned) |
| `app.current_tenant` unset / NULL | INSERT | Policy block | T343 (planned) |

### §3.4 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Wrong-tenant GUC via raw SQL | `SET LOCAL app.current_tenant = '<tenant-b-uuid>'; SELECT * FROM tenant_product_categories;` | Only Tenant B categories visible | T343 (planned) |
| No tenant GUC | `SET LOCAL app.current_tenant = ''; SELECT * FROM tenant_product_categories;` | 0 rows | T343 (planned) |

> **Note on store-scoped criteria**: Not applicable — categories are
> tenant-owned and flat (Q7). No `store_id` column exists; no store-level RLS
> policy exists for this table.

---

## §4 — `store_product_overrides`

This table carries both `tenant_id` and `store_id` and has three RLS policies:
a tenant isolation SELECT policy, a store-scoped SELECT policy, and a tenant +
store write policy. Full matrix including store-scoped sub-cases applies.

### §4.1 — Own-tenant, own-store read (baseline)

| Actor | GUC `app.current_tenant` | GUC `app.current_store` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | SELECT | Rows returned | T342 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | INSERT | Success | T372 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | UPDATE | Success | T374 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | DELETE / retire | Success | T374 (planned) |

### §4.2 — Cross-tenant read denied

| Actor | GUC `app.current_tenant` | Target row `tenant_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows — safe non-disclosing response | T341, T342 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | INSERT | Policy block | T341, T342 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | UPDATE | 0 rows affected | T341, T342 (planned) |

### §4.3 — Same-store override read

| Actor | GUC `app.current_store` | Target row `store_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Store X UUID | Store X | SELECT | Rows returned | T342 (planned) |
| Tenant A (Tenant Owner / Admin — cross-store read) | `''` (empty string) | Any store of Tenant A | SELECT | Rows returned for all Tenant A stores — `app.current_store = ''` allows cross-store reads by tenant owners | T342 (planned) |

### §4.4 — Cross-store override read denied

| Actor | GUC `app.current_tenant` | GUC `app.current_store` | Target row `store_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | Store Y (different store, same tenant) | SELECT | 0 rows — `store_product_overrides_store_read` policy filters to `app.current_store` | T342 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | Store Y | INSERT | Policy block — write restricted to `app.current_store` | T342, T372 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | Store Y | UPDATE | 0 rows affected | T342, T374 (planned) |

### §4.5 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Wrong-tenant GUC | `SET LOCAL app.current_tenant = '<tenant-b-uuid>'; SELECT * FROM store_product_overrides;` | Only Tenant B rows (tenant isolation holds) | T343 (planned) |
| Wrong-store GUC | `SET LOCAL app.current_store = '<store-y-uuid>'; SELECT * FROM store_product_overrides;` | Only Store Y rows (store isolation holds) | T343 (planned) |
| No tenant GUC | `SET LOCAL app.current_tenant = ''; SELECT * FROM store_product_overrides;` | 0 rows | T343 (planned) |

### §4.6 — Unset GUC — fail-closed

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_tenant` unset / NULL | SELECT | 0 rows | T343 (planned) |
| `app.current_store` unset (tenant-owner cross-store read with `''`) | SELECT | Rows for that tenant — permitted by design | T342 (planned) |
| `app.current_store` unset; `app.current_tenant` set | INSERT | Policy block (write requires both GUCs) | T343 (planned) |

---

## §5 — `product_aliases`

### Important note on store-scoped criteria for this table

`product_aliases` has **tenant-level RLS only**: `product_aliases_tenant_isolation`
(SELECT) and `product_aliases_tenant_write` (INSERT, UPDATE, DELETE). There is
no separate store-scoped RLS policy.

Store-level uniqueness for aliases is enforced via three partial unique indexes
(`UQ_idx_product_aliases_store_scoped`, etc.) at write time — not at the RLS
read layer. A tenant principal with a valid tenant GUC can read all aliases
belonging to their tenant, including store-scoped ones. Cross-store alias
isolation is a uniqueness and application-layer concern, not an RLS concern.

This means criteria (c) "same-store override read" and (d) "cross-store
override read denied" do not apply at the RLS layer for this table.

### §5.1 — Own-tenant read (baseline)

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | SELECT own aliases | Rows returned (all aliases for Tenant A, regardless of store scope) | T341 (planned) |
| Tenant A principal | Tenant A UUID | INSERT alias | Success | T383 (planned) |
| Tenant A principal | Tenant A UUID | UPDATE alias | Success | T383 (planned) |
| Tenant A principal | Tenant A UUID | DELETE / retire alias | Success | T383 (planned) |

### §5.2 — Cross-tenant read denied

| Actor | GUC `app.current_tenant` | Target row `tenant_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows — safe non-disclosing response | T341 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | INSERT with Tenant B `product_id` | Policy block — `tenant_id` resolved from GUC; Tenant B `product_id` fails FK or RLS | T344 (planned) |

### §5.3 — Unset GUC — fail-closed

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_tenant` unset / NULL | SELECT | 0 rows | T343 (planned) |
| `app.current_tenant` unset / NULL | INSERT | Policy block | T343 (planned) |

### §5.4 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Wrong-tenant GUC | `SET LOCAL app.current_tenant = '<tenant-b-uuid>'; SELECT * FROM product_aliases;` | Only Tenant B aliases visible | T343 (planned) |
| No tenant GUC | `SET LOCAL app.current_tenant = ''; SELECT * FROM product_aliases;` | 0 rows | T343 (planned) |

### §5.5 — Alias uniqueness probe (complementary — application layer / DDL)

This is not an RLS probe; it verifies the partial unique index constraints
enforced at the Postgres DDL layer (not via RLS policies). Included here for
completeness since T311 requires raw-SQL probe coverage of all seven tables.

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Tenant-wide barcode collision | Insert two aliases with same `(tenant_id, 'barcode', value)`, both `store_id IS NULL` | Second INSERT fails with unique constraint violation | T383 (planned) |
| `external_pos_id` without `source_system` | INSERT with `identifier_type = 'external_pos_id'` and `source_system IS NULL` | CHK constraint rejection | T383 (planned) |
| Store-scoped alias — cross-store uniqueness | Two aliases with same `(tenant_id, store_id, identifier_type, value)` for different stores | Each succeeds independently (different `store_id`) | T383 (planned) |

---

## §6 — `price_history`

### Important note on store-scoped criteria and UPDATE/DELETE

`price_history` has tenant-level RLS for SELECT and INSERT. The UPDATE and
DELETE policies are `FALSE` — **no session may update or delete a price history
row**, even within the same tenant. This is the immutability guarantee from
Constitution §13 enforced at the RLS layer (data-model.md §7).

For criteria (c) "same-store override read" and (d) "cross-store override read
denied": `price_history` has a nullable `store_id` column (NULL = tenant-level
price; NOT NULL = store-override price). The SELECT RLS policy is
`tenant_id = current_setting('app.current_tenant')::uuid` — it does not
additionally filter by `store_id`. A tenant principal can read all price
history rows belonging to their tenant, including rows for any store. Cross-
store price history isolation is not an RLS concern for this table; it is
managed by the application-layer presentation layer which scopes reads to the
correct (product, store) pair.

### §6.1 — Own-tenant read (baseline)

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | SELECT tenant-level price history | Rows returned | T400 (planned) |
| Tenant A principal | Tenant A UUID | SELECT store-override price history | Rows returned (store_id IS NOT NULL rows, same tenant) | T400 (planned) |
| Tenant A principal | Tenant A UUID | INSERT (via price change path) | Success — creates new interval row | T400 (planned) |

### §6.2 — Cross-tenant read denied

| Actor | GUC `app.current_tenant` | Target row `tenant_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows — safe non-disclosing response | T341 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | INSERT with Tenant B `product_id` | Policy block | T341 (planned) |

### §6.3 — Immutability probe (own-tenant UPDATE/DELETE denied)

| Actor | GUC `app.current_tenant` | Operation | Expected result | Task anchor |
|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | UPDATE own price history row | Denied — `price_history_no_update_delete` policy = `FALSE` | T402 (planned) |
| Tenant A principal | Tenant A UUID | DELETE own price history row | Denied — same policy | T402 (planned) |
| Platform Admin | any | UPDATE any price history row | Denied — `FALSE` applies to all sessions | T402 (planned) |

### §6.4 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Wrong-tenant GUC | `SET LOCAL app.current_tenant = '<tenant-b-uuid>'; SELECT * FROM price_history;` | Only Tenant B rows visible | T343 (planned) |
| No tenant GUC | `SET LOCAL app.current_tenant = ''; SELECT * FROM price_history;` | 0 rows | T343 (planned) |
| Attempt UPDATE via raw SQL | `SET LOCAL app.current_tenant = '<tenant-a-uuid>'; UPDATE price_history SET price = 0 WHERE tenant_id = '<tenant-a-uuid>';` | 0 rows affected — RLS `FALSE` policy denies all UPDATE | T343, T402 (planned) |
| Attempt DELETE via raw SQL | `SET LOCAL app.current_tenant = '<tenant-a-uuid>'; DELETE FROM price_history WHERE tenant_id = '<tenant-a-uuid>';` | 0 rows affected — RLS `FALSE` policy denies all DELETE | T343, T402 (planned) |

### §6.5 — Unset GUC — fail-closed

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_tenant` unset / NULL | SELECT | 0 rows | T343 (planned) |
| `app.current_tenant` unset / NULL | INSERT | Policy block | T343 (planned) |

---

## §7 — `unknown_items`

Like `store_product_overrides`, `unknown_items` is scoped to both `tenant_id`
and `store_id`. It has separate tenant isolation and store-scoped SELECT
policies, and separate INSERT and UPDATE (resolution) policies.

Note: `unknown_items` supports only INSERT and UPDATE (resolution) — there is
no DELETE policy. Records are permanent (non-soft-deleted) once written; their
`resolution_status` is the lifecycle field.

### §7.1 — Own-tenant, own-store read (baseline)

| Actor | GUC `app.current_tenant` | GUC `app.current_store` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | SELECT pending items | Rows returned | T342, T390 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | INSERT new unknown item | Success | T390 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | UPDATE (resolve) own item | Success | T392 (planned) |

### §7.2 — Cross-tenant read denied

| Actor | GUC `app.current_tenant` | Target row `tenant_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A principal | Tenant A UUID | Tenant B | SELECT | 0 rows — safe non-disclosing response | T341, T342 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | INSERT | Policy block | T344 (planned) |
| Tenant A principal | Tenant A UUID | Tenant B | UPDATE (resolve) | 0 rows affected | T341, T342 (planned) |

### §7.3 — Same-store read

| Actor | GUC `app.current_store` | Target row `store_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Store X UUID | Store X | SELECT | Rows returned | T342 (planned) |
| Tenant A (Tenant Owner / Admin) | `''` (empty string) | Any store of Tenant A | SELECT | All Tenant A unknown items returned — `app.current_store = ''` allows cross-store reads by tenant owners | T342 (planned) |

### §7.4 — Cross-store read denied

| Actor | GUC `app.current_tenant` | GUC `app.current_store` | Target row `store_id` | Operation | Expected result | Task anchor |
|---|---|---|---|---|---|
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | Store Y (different store, same tenant) | SELECT | 0 rows — `unknown_items_store_read` filters to `app.current_store` | T342 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | Store Y | INSERT for Store Y | Policy block — INSERT policy requires `tenant_id` from GUC, but `store_id` in row body must match application-resolved store | T344 (planned) |
| Tenant A / Store X principal | Tenant A UUID | Store X UUID | Store Y | UPDATE (resolve) | 0 rows affected — `unknown_items_resolve` scopes to `app.current_tenant`; application guard checks store ownership | T342 (planned) |

### §7.5 — Raw-SQL probe (planned, Testcontainers-backed)

| Scenario | SQL pattern | Expected result | Task anchor |
|---|---|---|---|
| Wrong-tenant GUC | `SET LOCAL app.current_tenant = '<tenant-b-uuid>'; SELECT * FROM unknown_items;` | Only Tenant B rows visible | T343 (planned) |
| Wrong-store GUC | `SET LOCAL app.current_store = '<store-y-uuid>'; SELECT * FROM unknown_items;` | Only Store Y rows visible | T343 (planned) |
| No tenant GUC | `SET LOCAL app.current_tenant = ''; SELECT * FROM unknown_items;` | 0 rows | T343 (planned) |
| No store GUC (tenant-owner cross-store read) | `SET LOCAL app.current_tenant = '<tenant-a-uuid>'; SET LOCAL app.current_store = ''; SELECT * FROM unknown_items;` | All Tenant A unknown items (cross-store allowed for empty store GUC) | T342 (planned) |

### §7.6 — Unset GUC — fail-closed

| GUC state | Operation | Expected result | Task anchor |
|---|---|---|---|
| `app.current_tenant` unset / NULL | SELECT | 0 rows | T343 (planned) |
| `app.current_tenant` unset / NULL | INSERT | Policy block | T343 (planned) |
| `app.current_store` unset; `app.current_tenant` set | SELECT | 0 rows (store isolation policy returns no match when store GUC absent) | T343 (planned) |

### §7.7 — Malicious body-override probe

| Injected field | Injected value | Expected outcome | Task anchor |
|---|---|---|---|
| `tenant_id` in request body | Foreign tenant UUID | Rejected by Zod `.strict()` DTO | T344 (planned) |
| `store_id` in request body | Out-of-scope store UUID | Rejected by Zod `.strict()` DTO | T344 (planned) |
| `resolved_by` in request body | Arbitrary UUID (no authenticated actor) | Rejected — server resolves actor from authenticated principal | T344 (planned) |

---

## Implementation Pointers

- **Test files (planned — not yet authored)**:
  - Cross-tenant read sweep: `apps/api/test/catalog/isolation/cross-tenant-read.spec.ts` (T341)
  - Cross-store read sweep: `apps/api/test/catalog/isolation/cross-store-read.spec.ts` (T342)
  - RLS bypass probe (raw SQL): `apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts` (T343)
  - Malicious body-override: `apps/api/test/catalog/isolation/malicious-override.spec.ts` (T344)
  - Isolation test harness: `apps/api/test/catalog/__support__/isolation-harness.ts` (T340)
  - Price history immutability: `apps/api/test/catalog/price-history.service.immutability.spec.ts` (T402)

- **RLS policy migrations (planned — not yet authored)**:
  - `packages/db/drizzle/0001_catalog.sql` (T330, gated) — will contain `CREATE POLICY` statements for all seven tables.
  - `packages/db/drizzle/0001_catalog.down.sql` (T330, gated) — rollback.

- **GUC helper utility**:
  Inherited from Feature 001 at `packages/db/src/helpers/with-tenant.ts` and `packages/db/src/helpers/with-store.ts`. Not modified by this feature. Verified for catalog use by T335 and T336.

- **Testcontainers setup**:
  Planned at `apps/api/test/catalog/__support__/isolation-harness.ts` (T340).
  Inherits the shared Postgres test harness from Feature 001 (`test/setup.ts`).

- **Drizzle schema files (planned — not yet authored)**:
  `packages/db/src/schema/catalog/` (T320, gated).

---

> **Status reminder**: This matrix is a planning and design artifact, not an
> implementation artifact. No test files exist. All scenarios are marked with
> task IDs from `tasks.md` that represent the future test-first obligation. A
> scenario marked "planned" means: the test must be written (in the phase shown
> by the task ID) and must pass before the corresponding implementation phase
> is considered complete. Raw-SQL probe scenarios require Testcontainers-backed
> Postgres per Constitution §6 — they cannot be satisfied by unit mocks.
