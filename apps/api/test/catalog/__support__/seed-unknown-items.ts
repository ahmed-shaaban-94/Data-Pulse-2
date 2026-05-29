/**
 * T506 — 005 `unknown_items` isolation-fixture extension.
 * T610/T611 additions — alias-conflict fixture helpers (005-WAVE2-CONFLICT).
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
  PRODUCT_A_ACTIVE,
  PRODUCT_B_ACTIVE,
  ACTOR_A,
  ACTOR_B,
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

// ----------------------------------------------------------------------------
// T024 (007) — terminal-state rows for the review-queue surface
// ----------------------------------------------------------------------------
//
// The 005 Wave-1 fixture above seeds only PENDING rows. 007 needs DISMISSED
// rows (for reopen + ?status=dismissed terminal-detail) and RESOLVED rows (for
// ?status=resolved terminal-detail and the reopen-on-resolved 409 path) across
// the full 4-cell tenant×store matrix, so the cross-tenant/cross-store sweep
// can probe a terminal row in every cell.
//
// Schema constraints honored (0007_catalog.sql §8):
//   - unknown_items_resolved_fields_consistent — a non-pending row MUST have
//     resolved_at, resolved_by, resolution_action all NOT NULL.
//   - resolved_product_id consistency CHK —
//       dismissed → resolution_action='dismissed' AND resolved_product_id NULL
//       resolved  → resolution_action IN ('linked','created') AND
//                   resolved_product_id NOT NULL
//   - the (tenant_id, store_id) and (tenant_id, identifier_type, value) partial
//     unique indexes are WHERE resolution_status='pending', so terminal rows do
//     NOT collide with the pending fixture even on a shared store/value.
//
// Distinct `value`s and a disjoint UUID space (`d6d*` dismissed, `d6e*`
// resolved) keep these clear of both the 005 pending block and the 003 fixture.

/** Dismissed barcode rows — one per cell (resolution_action='dismissed'). */
export const UNK_007_A_X_DISMISSED = "0a000000-0000-7000-8000-00000005d6d1";
export const UNK_007_A_Y_DISMISSED = "0a000000-0000-7000-8000-00000005d6d2";
export const UNK_007_B_X_DISMISSED = "0b000000-0000-7000-8000-00000005d6d3";
export const UNK_007_B_Y_DISMISSED = "0b000000-0000-7000-8000-00000005d6d4";

/** Resolved barcode rows — one per cell (resolution_action='linked'). */
export const UNK_007_A_X_RESOLVED = "0a000000-0000-7000-8000-00000005d6e1";
export const UNK_007_A_Y_RESOLVED = "0a000000-0000-7000-8000-00000005d6e2";
export const UNK_007_B_X_RESOLVED = "0b000000-0000-7000-8000-00000005d6e3";
export const UNK_007_B_Y_RESOLVED = "0b000000-0000-7000-8000-00000005d6e4";

/** Correlation IDs for the 8 terminal rows (NOT NULL per schema). */
export const UNK_007_A_X_DISMISSED_CORR = "0a000000-0000-7000-8000-00000005c6d1";
export const UNK_007_A_Y_DISMISSED_CORR = "0a000000-0000-7000-8000-00000005c6d2";
export const UNK_007_B_X_DISMISSED_CORR = "0b000000-0000-7000-8000-00000005c6d3";
export const UNK_007_B_Y_DISMISSED_CORR = "0b000000-0000-7000-8000-00000005c6d4";
export const UNK_007_A_X_RESOLVED_CORR = "0a000000-0000-7000-8000-00000005c6e1";
export const UNK_007_A_Y_RESOLVED_CORR = "0a000000-0000-7000-8000-00000005c6e2";
export const UNK_007_B_X_RESOLVED_CORR = "0b000000-0000-7000-8000-00000005c6e3";
export const UNK_007_B_Y_RESOLVED_CORR = "0b000000-0000-7000-8000-00000005c6e4";

/** Distinct identifier values for the terminal rows. */
export const UNK_007_VAL_A_X_DISMISSED = "T024-A-X-DIS-001";
export const UNK_007_VAL_A_Y_DISMISSED = "T024-A-Y-DIS-001";
export const UNK_007_VAL_B_X_DISMISSED = "T024-B-X-DIS-001";
export const UNK_007_VAL_B_Y_DISMISSED = "T024-B-Y-DIS-001";
export const UNK_007_VAL_A_X_RESOLVED = "T024-A-X-RES-001";
export const UNK_007_VAL_A_Y_RESOLVED = "T024-A-Y-RES-001";
export const UNK_007_VAL_B_X_RESOLVED = "T024-B-X-RES-001";
export const UNK_007_VAL_B_Y_RESOLVED = "T024-B-Y-RES-001";

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
  // T024 (007) — terminal-state rows, one dismissed + one resolved per cell.
  readonly dismissedAX: string;
  readonly dismissedAY: string;
  readonly dismissedBX: string;
  readonly dismissedBY: string;
  readonly resolvedAX: string;
  readonly resolvedAY: string;
  readonly resolvedBX: string;
  readonly resolvedBY: string;
  /** The product each resolved row links to (FR-001a product-reference subject). */
  readonly resolvedProductA: string;
  readonly resolvedProductB: string;
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
  dismissedAX: UNK_007_A_X_DISMISSED,
  dismissedAY: UNK_007_A_Y_DISMISSED,
  dismissedBX: UNK_007_B_X_DISMISSED,
  dismissedBY: UNK_007_B_Y_DISMISSED,
  resolvedAX: UNK_007_A_X_RESOLVED,
  resolvedAY: UNK_007_A_Y_RESOLVED,
  resolvedBX: UNK_007_B_X_RESOLVED,
  resolvedBY: UNK_007_B_Y_RESOLVED,
  resolvedProductA: PRODUCT_A_ACTIVE,
  resolvedProductB: PRODUCT_B_ACTIVE,
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
  // T024 (007): terminal rows added to the same disjoint UUID space.
  barcodeDismissed: 4,
  barcodeResolved: 4,
  total: 14,
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

  // ---- T024 (007): dismissed barcode rows (one per cell) ------------------
  // Terminal row: resolution_status='dismissed' → resolution_action='dismissed',
  // resolved_at/resolved_by NOT NULL, resolved_product_id MUST be NULL
  // (unknown_items resolved_product_id consistency CHK). resolved_by carries
  // the tenant's actor.
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value, source_system,
        resolution_status, resolution_action, resolved_at, resolved_by,
        resolved_product_id, correlation_id)
     VALUES
       ($1,  $2,  $3,  'barcode', $4,  NULL, 'dismissed', 'dismissed', now(), $5,  NULL, $6),
       ($7,  $2,  $8,  'barcode', $9,  NULL, 'dismissed', 'dismissed', now(), $5,  NULL, $10),
       ($11, $12, $13, 'barcode', $14, NULL, 'dismissed', 'dismissed', now(), $15, NULL, $16),
       ($17, $12, $18, 'barcode', $19, NULL, 'dismissed', 'dismissed', now(), $15, NULL, $20)
     ON CONFLICT DO NOTHING`,
    [
      UNK_007_A_X_DISMISSED, TENANT_A, STORE_A_X, UNK_007_VAL_A_X_DISMISSED, ACTOR_A, UNK_007_A_X_DISMISSED_CORR,
      UNK_007_A_Y_DISMISSED, STORE_A_Y, UNK_007_VAL_A_Y_DISMISSED, UNK_007_A_Y_DISMISSED_CORR,
      UNK_007_B_X_DISMISSED, TENANT_B, STORE_B_X, UNK_007_VAL_B_X_DISMISSED, ACTOR_B, UNK_007_B_X_DISMISSED_CORR,
      UNK_007_B_Y_DISMISSED, STORE_B_Y, UNK_007_VAL_B_Y_DISMISSED, UNK_007_B_Y_DISMISSED_CORR,
    ],
  );

  // ---- T024 (007): resolved barcode rows (one per cell) -------------------
  // Terminal row: resolution_status='resolved' → resolution_action='linked',
  // resolved_at/resolved_by NOT NULL, resolved_product_id MUST be NOT NULL and
  // reference a product owned by the SAME tenant. Tenant A rows link
  // PRODUCT_A_ACTIVE / ACTOR_A; tenant B rows link PRODUCT_B_ACTIVE / ACTOR_B.
  //
  // ⚠ SAME-TENANT INVARIANT (maintenance trap): the unknown_items →
  // tenant_products FK validates EXISTENCE only, not tenant ownership — Postgres
  // will happily accept (tenant_id=A, resolved_product_id=<B's product>). The
  // product↔tenant pairing below is therefore enforced HERE, by construction:
  //   TENANT_A ↔ PRODUCT_A_ACTIVE / ACTOR_A    (both 0a… ids, isolation-harness)
  //   TENANT_B ↔ PRODUCT_B_ACTIVE / ACTOR_B    (both 0b… ids)
  // If you change the product/actor fixtures, keep each cell's product+actor in
  // the SAME tenant as its tenant_id, or you seed a cross-tenant reference the
  // schema will NOT catch (it would only surface as a confusing RLS/test
  // failure downstream).
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value, source_system,
        resolution_status, resolution_action, resolved_at, resolved_by,
        resolved_product_id, correlation_id)
     VALUES
       ($1,  $2,  $3,  'barcode', $4,  NULL, 'resolved', 'linked', now(), $5,  $6,  $7),
       ($8,  $2,  $9,  'barcode', $10, NULL, 'resolved', 'linked', now(), $5,  $6,  $11),
       ($12, $13, $14, 'barcode', $15, NULL, 'resolved', 'linked', now(), $16, $17, $18),
       ($19, $13, $20, 'barcode', $21, NULL, 'resolved', 'linked', now(), $16, $17, $22)
     ON CONFLICT DO NOTHING`,
    [
      UNK_007_A_X_RESOLVED, TENANT_A, STORE_A_X, UNK_007_VAL_A_X_RESOLVED, ACTOR_A, PRODUCT_A_ACTIVE, UNK_007_A_X_RESOLVED_CORR,
      UNK_007_A_Y_RESOLVED, STORE_A_Y, UNK_007_VAL_A_Y_RESOLVED, UNK_007_A_Y_RESOLVED_CORR,
      UNK_007_B_X_RESOLVED, TENANT_B, STORE_B_X, UNK_007_VAL_B_X_RESOLVED, ACTOR_B, PRODUCT_B_ACTIVE, UNK_007_B_X_RESOLVED_CORR,
      UNK_007_B_Y_RESOLVED, STORE_B_Y, UNK_007_VAL_B_Y_RESOLVED, UNK_007_B_Y_RESOLVED_CORR,
    ],
  );

  return UNKNOWN_ITEMS_FIXTURE_IDS;
}

// ============================================================================
// T610 / T611 — Alias-conflict fixture (005-WAVE2-CONFLICT)
// ============================================================================
//
// These IDs and helpers are exclusively for the alias-conflict safety-floor
// specs. They are disjoint from the T506 Wave 1 fixture above.
//
// UUIDv7-shaped literals; `t610` and `t611` mnemonics (hex-safe: all a-f
// digits). The memory rule (feedback_uuid_hex_literals) prohibits
// non-hex mnemonic prefix bytes — `t` is dropped; numerals are decimal.

// ----------------------------------------------------------------------------
// T610 conflict items — two pending unknown items in TENANT_A, both with
// identifier_type='barcode', value='T340-A-BAR-001'. U1 is at STORE_A_X,
// U2 is at STORE_A_Y.
//
// FR-040 store-scoped semantics: the reconciliation link path writes the new
// alias with store_id = the unknown item's store (reconciliation.service.ts:
// "store_id carries the item's store to preserve the store-scoped partial
// unique index semantics"). To make linking U1 actually conflict, the fixture
// seeds a STORE-SCOPED product_aliases row at
// (TENANT_A, STORE_A_X, 'barcode', 'T340-A-BAR-001'). Linking U1 (STORE_A_X)
// then produces a second store-scoped row with identical
// (tenant_id, store_id, identifier_type, value) -> 23505 on the store-scoped
// partial unique index (WHERE store_id IS NOT NULL) -> 409 alias_conflict.
//
// Linking U2 (STORE_A_Y) writes a STORE_A_Y-scoped alias which lands in a
// DIFFERENT partition and does NOT collide -> 200. The tenant-wide
// ALIAS_A_BARCODE (store_id=NULL) from isolation-harness.ts lives in the
// tenant-wide partition and is never touched by these store-scoped INSERTs.
// ----------------------------------------------------------------------------

/** Pending unknown item U1 in TENANT_A / STORE_A_X — barcode 'T340-A-BAR-001'. */
export const UNK_CONFLICT_A_X_U1 = "0a000000-0000-7000-8000-00000610c001";
/** Pending unknown item U2 in TENANT_A / STORE_A_Y — barcode 'T340-A-BAR-001' (store-scope isolation). */
export const UNK_CONFLICT_A_Y_U2 = "0a000000-0000-7000-8000-00000610c002";
/** Correlation IDs for the conflict items. */
export const UNK_CONFLICT_A_X_U1_CORR = "0a000000-0000-7000-8000-000006100c01";
export const UNK_CONFLICT_A_Y_U2_CORR = "0a000000-0000-7000-8000-000006100c02";
/** Shared barcode value used by U1, U2, and the store-scoped seeded alias below. */
export const CONFLICT_BARCODE_VALUE = "T340-A-BAR-001";
/**
 * Store-scoped product_aliases row ID for the T610 conflict fixture.
 * Binds CONFLICT_BARCODE_VALUE to PRODUCT_A_ACTIVE at STORE_A_X (store-scoped).
 */
export const ALIAS_CONFLICT_A_X_U1_SCOPED =
  "0a000000-0000-7000-8000-000006100a01";

// ----------------------------------------------------------------------------
// T611 store-scoped conflict items — TENANT_A, barcode 'T611-STORE-BAR-Y01'
// bound to PRODUCT_A_ACTIVE at store STORE_A_X only (store-scoped alias).
// Linking an item from STORE_A_X produces 409; linking from STORE_A_Y
// should succeed (different store scope, no collision).
// ----------------------------------------------------------------------------

/** Store-scoped product_aliases row ID — for T611 setup only. */
export const ALIAS_CONFLICT_A_X_SCOPED = "0a000000-0000-7000-8000-000006110a01";
/** Barcode value for the T611 store-scoped alias. */
export const CONFLICT_STORE_BARCODE_VALUE = "T611-STORE-BAR-Y01";
/** Pending unknown item in TENANT_A / STORE_A_X — barcode 'T611-STORE-BAR-Y01' (CONFLICT). */
export const UNK_CONFLICT_STORE_X = "0a000000-0000-7000-8000-000006110c01";
/** Pending unknown item in TENANT_A / STORE_A_Y — barcode 'T611-STORE-BAR-Y01' (should succeed). */
export const UNK_CONFLICT_STORE_Y = "0a000000-0000-7000-8000-000006110c02";
/** Correlation IDs for T611 items. */
export const UNK_CONFLICT_STORE_X_CORR = "0a000000-0000-7000-8000-00000611c001";
export const UNK_CONFLICT_STORE_Y_CORR = "0a000000-0000-7000-8000-00000611c002";

/**
 * Seed fixture for T610 (FR-040, FR-042):
 *
 * Inserts two pending unknown_items rows in TENANT_A (U1 at STORE_A_X, U2 at
 * STORE_A_Y), both with (identifier_type='barcode', value='T340-A-BAR-001'),
 * plus a STORE-SCOPED product_aliases row at
 * (TENANT_A, STORE_A_X, 'barcode', 'T340-A-BAR-001') -> PRODUCT_A_ACTIVE.
 *
 * Why store-scoped (FR-040): the reconciliation link path writes the new alias
 * with store_id = the unknown item's store. A store-scoped INSERT never
 * violates the tenant-wide partial unique index (store_id IS NULL), so relying
 * on the tenant-wide ALIAS_A_BARCODE would NOT trigger a conflict. Seeding a
 * store-scoped alias at STORE_A_X makes linking U1 (STORE_A_X) collide on the
 * store-scoped partial unique index (store_id IS NOT NULL) -> 23505 -> 409.
 * Linking U2 (STORE_A_Y) writes into a different store partition and does NOT
 * collide -> 200.
 *
 * Preconditions:
 *   - applyAllUpAndCreateAppRole done
 *   - seedCatalogIsolationFixture done (seeds PRODUCT_A_ACTIVE, TENANT_A,
 *     STORE_A_X, STORE_A_Y, ACTOR_A)
 *
 * Idempotent via ON CONFLICT DO NOTHING.
 */
export async function seedAliasConflictFixture(env: SeedableEnv): Promise<void> {
  const { admin }: { admin: Pool } = env;

  // Store-scoped alias at STORE_A_X. The link path writes the item's store_id,
  // so linking U1 (STORE_A_X) reproduces (TENANT_A, STORE_A_X, 'barcode',
  // 'T340-A-BAR-001') and violates the store-scoped partial unique index
  // (UQ_idx_product_aliases_store_scoped, WHERE store_id IS NOT NULL). U2
  // (STORE_A_Y) targets a different partition and does not conflict.
  // source_system must be NULL for barcode rows per
  // product_aliases_source_system_required (0007_catalog.sql).
  await admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_CONFLICT_A_X_U1_SCOPED, TENANT_A, PRODUCT_A_ACTIVE,
      CONFLICT_BARCODE_VALUE, STORE_A_X, ACTOR_A,
    ],
  );

  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $7, 'barcode', $4, NULL, 'pending', $8)
     ON CONFLICT DO NOTHING`,
    [
      UNK_CONFLICT_A_X_U1, TENANT_A, STORE_A_X, CONFLICT_BARCODE_VALUE, UNK_CONFLICT_A_X_U1_CORR,
      UNK_CONFLICT_A_Y_U2, STORE_A_Y, UNK_CONFLICT_A_Y_U2_CORR,
    ],
  );
}

/**
 * Seed fixture for T611 (FR-040 store-scoped variant):
 *
 * Inserts a store-scoped product_aliases row binding barcode
 * 'T611-STORE-BAR-Y01' to PRODUCT_A_ACTIVE at STORE_A_X (TENANT_A).
 * Then inserts two pending unknown_items:
 *   - UNK_CONFLICT_STORE_X in STORE_A_X — conflicts with the store-scoped alias
 *   - UNK_CONFLICT_STORE_Y in STORE_A_Y — no alias at that store; should succeed
 *
 * The product_aliases_store_scope_consistency check allows
 * (store_id IS NOT NULL, identifier_type='barcode') — per 0007_catalog.sql.
 * source_system must be NULL for barcode rows per
 * product_aliases_source_system_required.
 *
 * Preconditions:
 *   - applyAllUpAndCreateAppRole done
 *   - seedCatalogIsolationFixture done (seeds PRODUCT_A_ACTIVE, TENANT_A,
 *     STORE_A_X, STORE_A_Y, ACTOR_A)
 *
 * Idempotent via ON CONFLICT DO NOTHING.
 */
export async function seedStoreScopedConflictFixture(env: SeedableEnv): Promise<void> {
  const { admin }: { admin: Pool } = env;

  // Store-scoped alias: barcode 'T611-STORE-BAR-Y01' bound to PRODUCT_A_ACTIVE
  // at STORE_A_X, tenant_id=TENANT_A. Triggers alias_conflict only when a
  // link attempt specifies the same (identifier_type, value, store_id=STORE_A_X).
  await admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_CONFLICT_A_X_SCOPED, TENANT_A, PRODUCT_A_ACTIVE,
      CONFLICT_STORE_BARCODE_VALUE, STORE_A_X, ACTOR_A,
    ],
  );

  // Two pending unknown items with the same barcode value but different stores
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $7, 'barcode', $4, NULL, 'pending', $8)
     ON CONFLICT DO NOTHING`,
    [
      UNK_CONFLICT_STORE_X, TENANT_A, STORE_A_X, CONFLICT_STORE_BARCODE_VALUE, UNK_CONFLICT_STORE_X_CORR,
      UNK_CONFLICT_STORE_Y, STORE_A_Y, UNK_CONFLICT_STORE_Y_CORR,
    ],
  );
}
