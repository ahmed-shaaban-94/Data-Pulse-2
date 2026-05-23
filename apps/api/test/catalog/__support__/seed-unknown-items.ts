/**
 * T506 — 005 `unknown_items` isolation-fixture extension.
 *
 * Purpose
 * -------
 * Sibling helper to the 003-owned `isolation-harness.ts`. Seeds an
 * **additional**, disjoint set of `unknown_items` rows targetable by
 * 005 Wave 1 specs (capture / list / dismiss / non-disclosing). The
 * 003 harness already seeds a 4-cell matrix of pending unknown items
 * for T341–T344's RLS sweep; this helper seeds a second, independent
 * 4-cell matrix specifically for 005's tests so that 005 specs can
 * assert against their own IDs without collisions against the 003
 * fixture, and so the existing 003 isolation suites (T341 31/31, T342
 * 17p+4t, T343 35p+4t, T344) remain untouched.
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned per Standing
 * Rules §3 and 005-WAVE1-HARNESS slice brief `forbidden_files`). This
 * file only **imports** types from there.
 *
 * Schema
 * ------
 * Aligned to `packages/db/drizzle/0007_catalog.sql` §8 (unknown_items
 * table) and `specs/005-pos-catalog-sync-reconciliation/data-model.md`
 * §1 + §2.1. Constraints relied upon:
 *   - `unknown_items_identifier_type_valid` — identifier_type ∈ {
 *     barcode, sku, plu, supplier_code, external_pos_id }
 *   - `unknown_items_value_length` — 1 ≤ length(value) ≤ 200
 *   - `unknown_items_source_system_required` — source_system IS NOT NULL
 *     iff identifier_type = 'external_pos_id'
 *   - `unknown_items_resolved_fields_consistent` — pending rows have
 *     resolved_at / resolved_by / resolution_action all NULL
 *   - `correlation_id` NOT NULL
 *
 * Tenants + stores
 * ----------------
 * Re-uses the **same** TENANT_A / TENANT_B / STORE_A_X / STORE_A_Y /
 * STORE_B_X / STORE_B_Y IDs from `isolation-harness.ts`. The 003
 * harness must have run first (or be running in the same setup) so
 * those parent rows exist. Consumers wire that ordering in
 * `beforeAll`.
 *
 * Discovery
 * ---------
 * Matches the 003 harness convention: `.ts` (not `.spec.ts`) so Jest's
 * `testMatch` does not pick this file up as a test. The slice's
 * validation command `pnpm --filter @data-pulse-2/api test
 * "test/catalog/__support__"` passes vacuously because the api `test`
 * script includes `--passWithNoTests` — the build/compile of this
 * file is what the validation is asserting, by design.
 */
import type { Pool } from "pg";

import {
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  STORE_B_Y,
  type SeedableEnv,
} from "./isolation-harness";

// Re-export `SeedableEnv` so 005 specs that consume only this helper
// don't need to also import from `isolation-harness.ts`.
export type { SeedableEnv } from "./isolation-harness";

// ----------------------------------------------------------------------------
// Fixture IDs — `t506` mnemonic prefix, distinct from 003's `t340` prefix
// ----------------------------------------------------------------------------
//
// UUIDv7-shaped literals. The hex-only mnemonic constraint (memory:
// feedback_uuid_hex_literals) limits us to a-f; `t506` reads as
// `u5d6` here — sufficient to disambiguate from the 003 fixture's
// `0a000000-...-a7xx` block.

/**
 * Pending unknown_items, identifier_type='barcode' (no source_system).
 * One per cell of the 4-cell tenant×store matrix.
 */
export const UNK_005_A_X_BARCODE = "0a000000-0000-7000-8000-00000005d6a1";
export const UNK_005_A_Y_BARCODE = "0a000000-0000-7000-8000-00000005d6a2";
export const UNK_005_B_X_BARCODE = "0b000000-0000-7000-8000-00000005d6b1";
export const UNK_005_B_Y_BARCODE = "0b000000-0000-7000-8000-00000005d6b2";

/**
 * Pending unknown_items, identifier_type='external_pos_id' (requires
 * source_system per CHK `unknown_items_source_system_required`).
 * One per tenant — store X only — to give downstream specs a row
 * that exercises the source_system code path without doubling the
 * fixture footprint.
 */
export const UNK_005_A_X_POS = "0a000000-0000-7000-8000-00000005d6a3";
export const UNK_005_B_X_POS = "0b000000-0000-7000-8000-00000005d6b3";

/**
 * Correlation IDs — NOT NULL on unknown_items per 0007_catalog.sql:404.
 * One per row.
 */
export const UNK_005_A_X_BARCODE_CORR = "0a000000-0000-7000-8000-00000005c0a1";
export const UNK_005_A_Y_BARCODE_CORR = "0a000000-0000-7000-8000-00000005c0a2";
export const UNK_005_B_X_BARCODE_CORR = "0b000000-0000-7000-8000-00000005c0b1";
export const UNK_005_B_Y_BARCODE_CORR = "0b000000-0000-7000-8000-00000005c0b2";
export const UNK_005_A_X_POS_CORR = "0a000000-0000-7000-8000-00000005c0a3";
export const UNK_005_B_X_POS_CORR = "0b000000-0000-7000-8000-00000005c0b3";

/**
 * Distinct identifier values per row. Kept short and ASCII to satisfy
 * `unknown_items_value_length` (1..200) with margin.
 */
export const UNK_005_VAL_A_X_BARCODE = "T506-A-X-BAR-001";
export const UNK_005_VAL_A_Y_BARCODE = "T506-A-Y-BAR-001";
export const UNK_005_VAL_B_X_BARCODE = "T506-B-X-BAR-001";
export const UNK_005_VAL_B_Y_BARCODE = "T506-B-Y-BAR-001";
export const UNK_005_VAL_A_X_POS = "T506-A-X-POS-001";
export const UNK_005_VAL_B_X_POS = "T506-B-X-POS-001";

/** source_system tag for the external_pos_id rows. */
export const UNK_005_SOURCE_SYSTEM = "t506-pos";

/**
 * Strongly-typed bundle of every ID this helper creates. 005 specs
 * destructure what they need.
 */
export interface UnknownItemsFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly storeAX: string;
  readonly storeAY: string;
  readonly storeBX: string;
  readonly storeBY: string;
  readonly unknownAXBarcode: string;
  readonly unknownAYBarcode: string;
  readonly unknownBXBarcode: string;
  readonly unknownBYBarcode: string;
  readonly unknownAXPos: string;
  readonly unknownBXPos: string;
  readonly valueAXBarcode: string;
  readonly valueAYBarcode: string;
  readonly valueBXBarcode: string;
  readonly valueBYBarcode: string;
  readonly valueAXPos: string;
  readonly valueBXPos: string;
  readonly sourceSystem: string;
}

/** Frozen ID record — what `seedUnknownItemsFixture` returns. */
export const UNKNOWN_ITEMS_FIXTURE_IDS: UnknownItemsFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  storeAX: STORE_A_X,
  storeAY: STORE_A_Y,
  storeBX: STORE_B_X,
  storeBY: STORE_B_Y,
  unknownAXBarcode: UNK_005_A_X_BARCODE,
  unknownAYBarcode: UNK_005_A_Y_BARCODE,
  unknownBXBarcode: UNK_005_B_X_BARCODE,
  unknownBYBarcode: UNK_005_B_Y_BARCODE,
  unknownAXPos: UNK_005_A_X_POS,
  unknownBXPos: UNK_005_B_X_POS,
  valueAXBarcode: UNK_005_VAL_A_X_BARCODE,
  valueAYBarcode: UNK_005_VAL_A_Y_BARCODE,
  valueBXBarcode: UNK_005_VAL_B_X_BARCODE,
  valueBYBarcode: UNK_005_VAL_B_Y_BARCODE,
  valueAXPos: UNK_005_VAL_A_X_POS,
  valueBXPos: UNK_005_VAL_B_X_POS,
  sourceSystem: UNK_005_SOURCE_SYSTEM,
});

/**
 * Expected row count after `seedUnknownItemsFixture` succeeds:
 *
 *   - 4 barcode-pending rows (1 per cell of A.X / A.Y / B.X / B.Y)
 *   - 2 external_pos_id-pending rows (A.X + B.X — exercises source_system)
 *
 * Total 6 NEW rows. These are **in addition to** the 4 rows the 003
 * harness already seeded (so the post-seed total in unknown_items is
 * 10 rows, split 5 per tenant). The 003 harness's own counts in
 * `CATALOG_FIXTURE_COUNTS.unknown_items` (= 4) are unchanged because
 * this helper writes to a disjoint UUID space.
 */
export const UNKNOWN_ITEMS_FIXTURE_COUNT = Object.freeze({
  barcodePending: 4,
  externalPosIdPending: 2,
  total: 6,
} as const);

// ----------------------------------------------------------------------------
// Seed function
// ----------------------------------------------------------------------------

/**
 * Seed the 005 unknown_items fixture against `env.admin`. Idempotent
 * via `ON CONFLICT DO NOTHING` on every INSERT — a consumer spec may
 * call this twice without harm. Returns the frozen ID record.
 *
 * Preconditions (consumer responsibilities):
 *   - The Postgres container is running.
 *   - Migrations 0000–0008 (or later) applied via
 *     `applyAllUpAndCreateAppRole` from
 *     `apps/api/test/_helpers/postgres-container.ts`.
 *   - The parent tenants/stores rows exist. The simplest way to
 *     guarantee this is to call `seedCatalogIsolationFixture` (from
 *     `isolation-harness.ts`) first; that helper seeds the same
 *     TENANT_A / TENANT_B / STORE_A_X / STORE_A_Y / STORE_B_X /
 *     STORE_B_Y IDs this helper depends on.
 *
 * What this helper does NOT do:
 *   - Seed tenants/stores. Re-seeding would conflict with 003's
 *     fixture; instead this helper relies on the 003 harness having
 *     run first.
 *   - Seed any non-unknown_items table.
 *   - Set RLS GUCs. The INSERTs run against `env.admin` (RLS bypass).
 */
export async function seedUnknownItemsFixture(
  env: SeedableEnv,
): Promise<UnknownItemsFixtureIds> {
  const { admin }: { admin: Pool } = env;

  // ---- barcode pending rows (one per store) -------------------------------
  // identifier_type='barcode' → source_system MUST be NULL per
  // unknown_items_source_system_required CHK.
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1,  $2, $3,  'barcode', $4,  NULL, 'pending', $5),
       ($6,  $2, $7,  'barcode', $8,  NULL, 'pending', $9),
       ($10, $11, $12, 'barcode', $13, NULL, 'pending', $14),
       ($15, $11, $16, 'barcode', $17, NULL, 'pending', $18)
     ON CONFLICT DO NOTHING`,
    [
      UNK_005_A_X_BARCODE, TENANT_A, STORE_A_X, UNK_005_VAL_A_X_BARCODE, UNK_005_A_X_BARCODE_CORR,
      UNK_005_A_Y_BARCODE, STORE_A_Y, UNK_005_VAL_A_Y_BARCODE, UNK_005_A_Y_BARCODE_CORR,
      UNK_005_B_X_BARCODE, TENANT_B, STORE_B_X, UNK_005_VAL_B_X_BARCODE, UNK_005_B_X_BARCODE_CORR,
      UNK_005_B_Y_BARCODE, STORE_B_Y, UNK_005_VAL_B_Y_BARCODE, UNK_005_B_Y_BARCODE_CORR,
    ],
  );

  // ---- external_pos_id pending rows (one per tenant, X store only) -------
  // identifier_type='external_pos_id' → source_system MUST be NOT NULL.
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'external_pos_id', $4, $5, 'pending', $6),
       ($7, $8, $9, 'external_pos_id', $10, $5, 'pending', $11)
     ON CONFLICT DO NOTHING`,
    [
      UNK_005_A_X_POS, TENANT_A, STORE_A_X, UNK_005_VAL_A_X_POS, UNK_005_SOURCE_SYSTEM, UNK_005_A_X_POS_CORR,
      UNK_005_B_X_POS, TENANT_B, STORE_B_X, UNK_005_VAL_B_X_POS, UNK_005_B_X_POS_CORR,
    ],
  );

  return UNKNOWN_ITEMS_FIXTURE_IDS;
}
