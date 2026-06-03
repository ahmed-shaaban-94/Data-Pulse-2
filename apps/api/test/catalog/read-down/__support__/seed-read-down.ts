/**
 * apps/api/test/catalog/read-down/__support__/seed-read-down.ts
 *
 * Slice 010-ISOLATION-HARNESS (T014) — read-down test fixtures.
 *
 * Companion seed for the 010 POS catalogue read-down sync. It builds ON TOP of
 * the 003-owned `seedCatalogIsolationFixture` (tenants A/B × stores X/Y, base
 * products, overrides, aliases) — which it calls first — and adds the
 * read-down-specific rows US1 (snapshot) + US2 (delta) exercise:
 *
 *   - a PRICED SELLABLE product in tenant A (the happy path: priced + active +
 *     not retired + representable);
 *   - the three sellable-EXCLUSION cases the resolver must omit (R5, FR-041/044):
 *       • `null_price`        — both price + currency NULL (unpriced);
 *       • `non_representable` — a VALID paired price whose scale exceeds the
 *         currency's minor unit (`9.999` in EGP = 2 minor digits); the row is
 *         legal at the DB layer, the RESOLVER excludes it;
 *       • `missing_currency`  — UNREACHABLE as stored data: both
 *         `tenant_products` and `store_product_overrides` carry a strict
 *         both-or-neither price/currency CHECK
 *         (`*_currency_paired`), so price-present-currency-NULL cannot be
 *         stored at either layer. Documented here as a defensive/unreachable
 *         branch; we do NOT subvert the CHECK to force it. The resolver still
 *         guards against it (defense-in-depth) but no fixture row can produce it.
 *   - a STORE OVERRIDE in store A-X that changes the priced product's price
 *     (so US1 can assert field-by-field Tenant ⊕ Override resolution);
 *   - an EMPTY-SELLABLE store (A-Y) — has products in tenant A but none
 *     resolve sellable for it, so the snapshot is a valid EMPTY page at a cursor
 *     ("synced, empty" ≠ "never synced").
 *
 * IMPORTANT (execution-map stop): this file MUST NOT modify the 003-owned
 * `apps/api/test/catalog/__support__/isolation-harness.ts`. It imports the
 * parent fixture IDs from it and seeds only NEW rows. `.ts` (not `.spec.ts`) so
 * Jest does not collect it as a test.
 *
 * IDs use the `0a…d010…` mnemonic shape (UUIDv7-like, hex a-f only) to stay
 * unique against the `t340` catalog corpus (memory: feedback_uuid_hex_literals).
 */
import {
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  seedCatalogIsolationFixture,
  type SeedableEnv,
} from "../../__support__/isolation-harness";

// ----------------------------------------------------------------------------
// Read-down-specific fixture IDs
// ----------------------------------------------------------------------------

/** Priced + active + representable → the SELLABLE happy-path product (tenant A). */
export const PRODUCT_A_SELLABLE = "0a000000-0000-7000-8000-00000d010111";
/** Both price + currency NULL → excluded as `null_price`. */
export const PRODUCT_A_UNPRICED = "0a000000-0000-7000-8000-00000d010222";
/** Valid paired price `9.999` in EGP (2dp) → excluded as `non_representable`. */
export const PRODUCT_A_NONREPR = "0a000000-0000-7000-8000-00000d010333";
/** Store A-X override that changes PRODUCT_A_SELLABLE's price (Tenant ⊕ Override). */
export const OVERRIDE_AX_SELLABLE = "0a000000-0000-7000-8000-00000d010a11";

export interface ReadDownFixtureIds {
  readonly tenantA: string;
  readonly storeSellable: string; // A-X — has a sellable resolved product
  readonly storeEmptySellable: string; // A-Y — no sellable products resolve
  readonly sellableProduct: string;
  readonly unpricedProduct: string;
  readonly nonRepresentableProduct: string;
  readonly overrideAxSellable: string;
}

export const READ_DOWN_FIXTURE_IDS: ReadDownFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  storeSellable: STORE_A_X,
  storeEmptySellable: STORE_A_Y,
  sellableProduct: PRODUCT_A_SELLABLE,
  unpricedProduct: PRODUCT_A_UNPRICED,
  nonRepresentableProduct: PRODUCT_A_NONREPR,
  overrideAxSellable: OVERRIDE_AX_SELLABLE,
});

/**
 * Seed the read-down fixtures. Calls `seedCatalogIsolationFixture` first (its
 * parents — tenants/stores/base products), then adds the 010 rows. Idempotent
 * (`ON CONFLICT DO NOTHING`) so it is safe to call once per suite.
 */
export async function seedReadDownFixture(
  env: SeedableEnv,
): Promise<ReadDownFixtureIds> {
  await seedCatalogIsolationFixture(env);
  const { admin } = env;

  // ---- Read-down tenant_products (priced sellable + the exclusion cases) ----
  // The base harness products carry NO price (default_price/currency NULL), so
  // they are already `null_price`; we add an explicit one for clarity plus the
  // priced-sellable + non-representable rows.
  await admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, default_price, default_currency_code, is_active,
        tax_category, created_by, updated_by)
     VALUES
       -- SELLABLE: priced, active, representable (EGP, 2dp).
       ($1, $2, '010 Sellable Widget', '9.99', 'EGP', true, 'standard', $3, $3),
       -- null_price: both NULL → excluded.
       ($4, $2, '010 Unpriced Widget', NULL, NULL, true, 'standard', $3, $3),
       -- non_representable: VALID paired price (CHECK satisfied) whose 3rd
       -- decimal exceeds EGP's 2 minor digits → the resolver excludes it.
       ($5, $2, '010 NonRepr Widget', '9.999', 'EGP', true, 'standard', $3, $3)
     ON CONFLICT DO NOTHING`,
    [
      PRODUCT_A_SELLABLE, TENANT_A, ACTOR_A,
      PRODUCT_A_UNPRICED,
      PRODUCT_A_NONREPR,
    ],
  );

  // ---- Store A-X override on the sellable product (price deviation) ---------
  // Resolved(A-X, sellable product) = Tenant ⊕ Override → price 8.50 (override
  // wins). Store A-Y has NO override and the base product it could resolve
  // (PRODUCT_A_ACTIVE) is itself unpriced, so A-Y resolves zero sellable rows
  // → the empty-sellable snapshot case.
  await admin.query(
    `INSERT INTO store_product_overrides
       (id, tenant_id, store_id, product_id, price, currency_code,
        is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, '8.50', 'EGP', true, $5, $5)
     ON CONFLICT DO NOTHING`,
    [OVERRIDE_AX_SELLABLE, TENANT_A, STORE_A_X, PRODUCT_A_SELLABLE, ACTOR_A],
  );

  // NOTE — `missing_currency` (resolved price-present + currency-NULL) is
  // UNREACHABLE: the strict `*_currency_paired` CHECK on both tenant_products
  // and store_product_overrides forbids price-without-currency. We deliberately
  // seed NO such row. The resolver still guards it (defense-in-depth); the
  // fixture corpus simply cannot produce it.

  return READ_DOWN_FIXTURE_IDS;
}
