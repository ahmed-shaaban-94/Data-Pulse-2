/**
 * apps/api/test/catalog/erpnext-posting/__support__/seed-posting-status.ts
 *
 * Slice 015-ISOLATION-HARNESS (T020) — erpnext_posting_status test fixtures.
 *
 * Companion seed for the 015 POS-sale-posting surface. It builds ON TOP of the
 * 008-owned `seedSalesFixture` (which itself calls the 003-owned catalog
 * isolation fixture) — so the parent sales + void/refund terminal events the
 * composite FK + the reversal rows reference already exist — and adds the
 * `erpnext_posting_status` rows the isolation sweep + US1-FEED specs exercise:
 *
 *   - tenant A: a PENDING `sale_post` on SALE_A_X (the resolvable happy-path
 *     feed row) + a `reversal` on the VOID terminal event of SALE_VOIDED_A_X
 *     (proves multiple posting rows can reference the same tenant/store and that
 *     a reversal is keyed on its own originating row);
 *   - tenant B: a POSTED `sale_post` on SALE_B_X (carries a document_ref) — the
 *     cross-tenant target the sweep proves tenant A can never read.
 *
 * `erpnext_posting_status` is TENANT-only — `store_id` is a tenant-local FK, not
 * a second RLS axis (data-model §5). So this seed sets only `app.current_tenant`
 * (no `app.current_store`), and the sweep's cross-store assertion is vacuous.
 *
 * IMPORTANT (execution-map stop): this file MUST NOT modify the 003-owned
 * `isolation-harness.ts` or the 008-owned `seed-sales.ts`. It imports their IDs
 * and seeds only NEW rows via the `admin` (RLS-bypassing) pool. `.ts` (not
 * `.spec.ts`) so Jest does not collect it as a test.
 *
 * IDs use the `…0e0515…` mnemonic shape (hex a-f only) to stay unique against
 * the catalog / 008 / 013 / 014 corpora.
 */
import {
  SALES_SOURCE_SYSTEM,
  SALE_A_X,
  SALE_B_X,
  SALE_VOIDED_A_X,
  VOID_A_X,
  seedSalesFixture,
  type SeedableEnv,
} from "../../sales/__support__/seed-sales";
import {
  ACTOR_A,
  STORE_A_X,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from "../../__support__/isolation-harness";

// ----------------------------------------------------------------------------
// 015-specific fixture IDs
// ----------------------------------------------------------------------------

/** Tenant A — PENDING sale_post on SALE_A_X (the resolvable feed row). */
export const POST_A_PENDING = "0a000000-0000-7000-8000-00000e0515a1";
/** Tenant A — reversal of the VOID terminal event of SALE_VOIDED_A_X. */
export const POST_A_REVERSAL = "0a000000-0000-7000-8000-00000e0515a2";
/** Tenant B — POSTED sale_post on SALE_B_X (the cross-tenant target). */
export const POST_B_POSTED = "0b000000-0000-7000-8000-00000e0515b1";

/** The ERPNext document ref the posted tenant-B row carries. */
export const POSTED_DOCUMENT_REF = "ACC-SINV-B-0001";

/**
 * A canonical 64-hex SHA-256-shaped payload hash (gate C). Defined locally — the
 * 008 `seed-sales.ts` keeps its own `PAYLOAD_HASH` module-private, and the
 * execution-map stop forbids modifying that 008-owned file to export it.
 */
const PAYLOAD_HASH = "a".repeat(64);

export interface PostingStatusFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly postAPending: string;
  readonly postAReversal: string;
  readonly postBPosted: string;
  readonly storeAMapped: string;
  readonly storeBMapped: string;
  readonly actorA: string;
}

export const POSTING_STATUS_FIXTURE_IDS: PostingStatusFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  postAPending: POST_A_PENDING,
  postAReversal: POST_A_REVERSAL,
  postBPosted: POST_B_POSTED,
  storeAMapped: STORE_A_X,
  storeBMapped: STORE_B_X,
  actorA: ACTOR_A,
});

/**
 * Seed the 015 fixtures. Calls `seedSalesFixture` first (catalog isolation +
 * sales + terminal events), then adds the erpnext_posting_status rows.
 * Idempotent (`ON CONFLICT DO NOTHING`) so it is safe to call once per suite.
 */
export async function seedPostingStatusFixture(
  env: SeedableEnv,
): Promise<PostingStatusFixtureIds> {
  // seedSalesFixture requires the catalog isolation fixture (parent tenants /
  // stores / actors) to exist first — it does NOT seed them itself (its
  // docstring §170). Run it before the sales rows, mirroring the 008 sales-sweep.
  await seedCatalogIsolationFixture(env);
  await seedSalesFixture(env);
  const { admin } = env;

  // ---- Tenant A: a PENDING sale_post + a reversal of a void -----------------
  // The reversal's source_ref_id is the VOID row's id (its own originating row),
  // NOT the sale's — the REVERSAL-CARDINALITY invariant (data-model §5).
  await admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, document_ref)
     VALUES
       ($1, $2, $3, $4, 'sale_post', $4,  $5, 'sale-A-X', $6, 'pending', NULL),
       ($7, $2, $3, $8, 'reversal',  $9,  $5, 'void-A-X', $6, 'pending', NULL)
     ON CONFLICT DO NOTHING`,
    [
      POST_A_PENDING, TENANT_A, STORE_A_X, SALE_A_X, SALES_SOURCE_SYSTEM, PAYLOAD_HASH,
      POST_A_REVERSAL, SALE_VOIDED_A_X, VOID_A_X,
    ],
  );

  // ---- Tenant B: a POSTED sale_post (the cross-tenant target) ---------------
  await admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, document_ref)
     VALUES
       ($1, $2, $3, $4, 'sale_post', $4, $5, 'sale-B-X', $6, 'posted', $7)
     ON CONFLICT DO NOTHING`,
    [
      POST_B_POSTED, TENANT_B, STORE_B_X, SALE_B_X, SALES_SOURCE_SYSTEM,
      PAYLOAD_HASH, POSTED_DOCUMENT_REF,
    ],
  );

  return POSTING_STATUS_FIXTURE_IDS;
}
