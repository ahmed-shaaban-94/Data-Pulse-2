/**
 * seed.ts — 009-US4 inventory-backfill worker test fixtures.
 *
 * Minimal, self-contained seeding for the backfill-processor specs (T064/T063b).
 * Seeds tenant → store → tenant_product → an UNPROCESSED (captured) sale with a
 * product-referenced line, all via the ADMIN pool (RLS-bypassing). The PROCESSOR
 * under test then runs against the non-superuser `app` pool, proving it must
 * establish `app.current_tenant` before any tenant-scoped read/INSERT (§V).
 *
 * `.ts` (not `.spec.ts`) so Jest's testMatch does not treat it as a test.
 * Does NOT import the api-side seed-sales/seed-inventory (apps/api is a separate
 * package; worker tests must not cross the app boundary — the audit-processor
 * precedent).
 */
import type { Pool } from "pg";

export interface SeedBackfillInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
  readonly actorId: string;
  /** Catalog product the sale line references (drives on-hand roll-up). */
  readonly productId: string;
  /** A unique slug suffix so parallel suites don't collide on tenant slug. */
  readonly slugSuffix: string;
  /** Per-line `(quantity, unit, productRef|null)` triples. */
  readonly lines: ReadonlyArray<{
    readonly quantity: string;
    readonly unit: string;
    readonly productRef: string | null;
  }>;
}

/**
 * Seed one tenant + store + catalog product + an UNPROCESSED captured sale and
 * its frozen lines. `processed_at` is left NULL — exactly the captured state the
 * backfill reads (R8). Returns the seeded sale_line ids in order.
 */
export async function seedCapturedSaleForBackfill(
  admin: Pool,
  input: SeedBackfillInput,
): Promise<string[]> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name)
       VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [input.tenantId, `wkr-inv-${input.slugSuffix}`, `Worker Inv ${input.slugSuffix}`],
  );

  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [input.storeId, input.tenantId, `S-${input.slugSuffix}`, `Store ${input.slugSuffix}`],
  );

  // The backfill writes an audit_events row whose actor_user_id REFERENCES
  // users(id) — seed the actor user or the audit INSERT fails the FK (the api
  // seed-inventory does the same).
  await admin.query(
    `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [input.actorId, `actor-${input.slugSuffix}@fixture.invalid`],
  );

  // tenant_products: minimal row the sale line + movement can reference (0007
  // schema: name, tax_category, created_by/updated_by are NOT NULL). The
  // backfill never auto-creates this — the test seeds it so a referenced line
  // rolls up to a real product's on-hand.
  await admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, 'standard', true, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [input.productId, input.tenantId, `Product ${input.slugSuffix}`, input.actorId],
  );

  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash,
        processed_at, mismatch_flag, created_by)
     VALUES ($1, $2, $3, 'USD', 0::numeric, now(),
             (now() AT TIME ZONE 'UTC')::date, 'pos-x', $4, $5,
             NULL, NULL, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.saleId,
      input.tenantId,
      input.storeId,
      // external_id is part of uq_sales_tenant_source_external — derive it from
      // the (unique) saleId so two sales under the same tenant never collide.
      `ext-${input.saleId}`,
      "0".repeat(64),
      input.actorId,
    ],
  );

  const lineIds: string[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i]!;
    const r = await admin.query<{ id: string }>(
      `INSERT INTO sale_lines
         (id, sale_id, tenant_id, store_id, line_name, unit_price,
          currency_code, quantity, line_amount, unit, tenant_product_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 1::numeric, 'USD',
               $5::numeric, 1::numeric, $6, $7)
       RETURNING id`,
      [
        input.saleId,
        input.tenantId,
        input.storeId,
        `line-${i}`,
        line.quantity,
        line.unit,
        line.productRef,
      ],
    );
    lineIds.push(r.rows[0]!.id);
  }
  return lineIds;
}

/** Derived on-hand for a (store, product) via the admin pool (RLS-bypass). */
export async function readOnHand(
  admin: Pool,
  storeId: string,
  productId: string,
): Promise<number> {
  const r = await admin.query<{ q: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS q
       FROM stock_movements
      WHERE store_id = $1 AND tenant_product_ref = $2`,
    [storeId, productId],
  );
  return Number(r.rows[0]!.q);
}

/** Count movements for a (store, product) — for "exactly one per line" asserts. */
export async function countMovements(
  admin: Pool,
  storeId: string,
  productId: string,
): Promise<number> {
  const r = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM stock_movements
      WHERE store_id = $1 AND tenant_product_ref = $2`,
    [storeId, productId],
  );
  return Number(r.rows[0]!.n);
}

/**
 * Bulk-append `count` sale_lines to an existing sale (009-POLISH T101 bound
 * test). One `generate_series` round-trip — used to seed an over-ceiling sale
 * (>500 lines) cheaply. All lines reference the same product in 'ea'.
 */
export async function seedManyLines(
  admin: Pool,
  input: {
    readonly saleId: string;
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId: string;
    readonly count: number;
  },
): Promise<void> {
  await admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price,
        currency_code, quantity, line_amount, unit, tenant_product_ref)
     SELECT gen_random_uuid(), $1, $2, $3, 'bulk-' || g, 1::numeric, 'USD',
            1::numeric, 1::numeric, 'ea', $4
       FROM generate_series(1, $5) AS g`,
    [input.saleId, input.tenantId, input.storeId, input.productId, input.count],
  );
}
