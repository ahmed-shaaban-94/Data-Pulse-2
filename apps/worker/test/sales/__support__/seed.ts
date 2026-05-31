/**
 * seed.ts — 008-WORKER sale-processing test fixtures.
 *
 * Minimal, self-contained seeding for the worker sale-processing specs
 * (T080/T081). Seeds tenant → store → sale (with `processed_at` NULL, mirroring
 * the capture path) → sale_lines, all via the ADMIN pool (RLS-bypassing) so the
 * fixtures exist regardless of tenant context. The PROCESSOR under test then
 * runs against the non-superuser `app` pool, which proves it must establish
 * `app.current_tenant` before any tenant-scoped read/UPDATE (§V).
 *
 * `.ts` (not `.spec.ts`) so Jest's testMatch does not treat it as a test —
 * matches the 003/005/008 support-helper convention. Lives under
 * `apps/worker/test/sales/**` (008-WORKER allowed_files).
 *
 * Does NOT import the api-side `seed-sales.ts` (apps/api is a separate package;
 * worker tests must not cross the app boundary).
 */
import type { Pool } from "pg";

export interface SeedSaleInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
  readonly actorId: string;
  /** A unique slug suffix so parallel suites don't collide on tenant slug. */
  readonly slugSuffix: string;
  readonly currencyCode: string;
  readonly posTotal: string;
  /** Per-line `line_amount` values (strings — no JS float). */
  readonly lineAmounts: ReadonlyArray<string>;
  readonly sourceSystem: string;
  readonly externalId: string;
}

/**
 * Seed one tenant + store + an UNPROCESSED captured sale and its frozen lines.
 * `processed_at` and `mismatch_flag` are left NULL — exactly the state the 008
 * capture path leaves for the off-request worker to claim.
 */
export async function seedUnprocessedSale(
  admin: Pool,
  input: SeedSaleInput,
): Promise<void> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name)
       VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [input.tenantId, `wkr-sale-${input.slugSuffix}`, `Worker Sale ${input.slugSuffix}`],
  );

  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [input.storeId, input.tenantId, `S-${input.slugSuffix}`, `Store ${input.slugSuffix}`],
  );

  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash,
        processed_at, mismatch_flag, created_by)
     VALUES ($1, $2, $3, $4, $5::numeric, now(),
             (now() AT TIME ZONE 'UTC')::date, $6, $7, $8,
             NULL, NULL, $9)`,
    [
      input.saleId,
      input.tenantId,
      input.storeId,
      input.currencyCode,
      input.posTotal,
      input.sourceSystem,
      input.externalId,
      // A 64-hex placeholder payload_hash (NOT NULL); the worker never reads it.
      "0".repeat(64),
      input.actorId,
    ],
  );

  for (let i = 0; i < input.lineAmounts.length; i++) {
    await admin.query(
      `INSERT INTO sale_lines
         (id, sale_id, tenant_id, store_id, line_name, unit_price,
          currency_code, quantity, line_amount, unit, tenant_product_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, $6,
               '1'::numeric, $7::numeric, 'each', NULL)`,
      [
        input.saleId,
        input.tenantId,
        input.storeId,
        `line-${i}`,
        input.lineAmounts[i],
        input.currencyCode,
        input.lineAmounts[i],
      ],
    );
  }
}

/** Read the SaaS-owned processing state directly (admin, RLS-bypass) for assertions. */
export async function readProcessingState(
  admin: Pool,
  saleId: string,
): Promise<{ processedAt: Date | null; mismatchFlag: boolean | null }> {
  const r = await admin.query<{ processed_at: Date | null; mismatch_flag: boolean | null }>(
    `SELECT processed_at, mismatch_flag FROM sales WHERE id = $1`,
    [saleId],
  );
  const row = r.rows[0];
  return {
    processedAt: row?.processed_at ?? null,
    mismatchFlag: row?.mismatch_flag ?? null,
  };
}
