/**
 * T523 — 005-WAVE1-LIST — Tenant-admin queue read spec.
 *
 * Acceptance (slice 005-WAVE1-LIST validation contract):
 *   GREEN — FR-014 store-scoped vs tenant-wide visibility:
 *     - Tenant admin (tenant-wide, storeId=null) sees all pending rows
 *       across all stores in their tenant.
 *     - Store-scoped operator (storeId=UUID) sees only their store's
 *       pending rows.
 *     - Cross-tenant probe (RLS does the filtering) returns an empty
 *       page, NOT an error — non-disclosing per SI-001 / FR-013.
 *
 * Spec anchors:
 *   - FR-014 — store-scoped operators see only their store's items;
 *     tenant-wide actors see everything in their tenant.
 *   - SI-001 / SI-004 / FR-013 — cross-tenant probe is non-disclosing
 *     (empty page, no error).
 *   - 003 `unknown_items_tenant_isolation` + `unknown_items_store_read`
 *     RLS policies do the filtering. Service does NOT add explicit
 *     `WHERE store_id = …` — relies on `app.current_store` GUC
 *     (empty-string for tenant-wide actors via 0009 carve-out; store
 *     UUID for store-scoped actors). Same pattern as `findByIdForTenant`
 *     from PR #332 / T522.
 *
 * Fixture (from `seedUnknownItemsFixture`, see
 * `apps/api/test/catalog/__support__/seed-unknown-items.ts`):
 *     - 4 barcode pending rows: A.X / A.Y / B.X / B.Y (1 each)
 *     - 2 external_pos_id pending rows: A.X + B.X
 *   Tenant A total: 2 barcode (A.X, A.Y) + 1 external_pos_id (A.X) = 3 rows
 *   Tenant B total: 2 barcode (B.X, B.Y) + 1 external_pos_id (B.X) = 3 rows
 *   Store A.X total: 1 barcode + 1 external_pos_id = 2 rows
 *   Store A.Y total: 1 barcode = 1 row
 *
 * Wiring strategy
 * ---------------
 * Service-direct test, mirrors `cross-tenant.spec.ts` (PR #332). The
 * service is constructed with `env.app` (the RLS-enforced app-role
 * pool); the seed fixture writes via `env.admin` (RLS bypass — correct
 * for fixture setup). No NestJS DI, no supertest, no controller —
 * T523 exercises the SERVICE method; the controller's `@Get` route
 * (T524) is verified structurally via TS build + the wider catalog
 * regression sweep, not by a per-route supertest call here.
 *
 * Why service-direct vs controller-direct
 * ---------------------------------------
 * The slice brief says "RLS does the cross-store filtering; the
 * service does not add explicit WHERE store_id = …". The invariant
 * lives at the service/SQL boundary, not at the HTTP boundary. A
 * service-direct test exercises the invariant where it lives.
 * Controller-level coverage (Zod validation of query params,
 * 401/403 envelopes) is wider than this slice's scope; T564 polish
 * or a future contract-conformance pass can extend.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { seedCatalogIsolationFixture } from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";

// --------------------------------------------------------------------------
// Suite-level state — mirrors cross-tenant.spec.ts (PR #332)
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: UnknownItemsService | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedUnknownItemsFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T523 list-queue.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  service = new UnknownItemsService(env.app);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[T523 list-queue.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// FR-014 — tenant-wide visibility
// --------------------------------------------------------------------------

describe("T523 / 005-WAVE1-LIST — tenant admin sees all stores", () => {
  it("tenant A admin (storeId=null) sees pending rows from A.X AND A.Y", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeId: null,
      status: "pending",
      limit: 50,
    });

    // 3 pending rows seeded for tenant A: 1 barcode at A.X, 1 barcode
    // at A.Y, 1 external_pos_id at A.X.
    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
      ].sort(),
    );

    // No tenant B rows leak across.
    const storeIds = new Set(result.items.map((r) => r.storeId));
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeBX)).toBe(false);
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeBY)).toBe(false);

    // Cursor null on Wave 1 (single-page within limit).
    expect(result.nextCursor).toBeNull();
  });

  it("tenant B admin (storeId=null) sees pending rows from B.X AND B.Y", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
      storeId: null,
      status: "pending",
      limit: 50,
    });

    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownBYBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXPos,
      ].sort(),
    );

    // No tenant A rows leak across.
    const storeIds = new Set(result.items.map((r) => r.storeId));
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeAX)).toBe(false);
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeAY)).toBe(false);

    expect(result.nextCursor).toBeNull();
  });
});

// --------------------------------------------------------------------------
// FR-014 — store-scoped visibility
// --------------------------------------------------------------------------

describe("T523 / 005-WAVE1-LIST — store-scoped operator sees only their store", () => {
  it("store-scoped to A.X sees A.X rows only — A.Y row is invisible", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeId: UNKNOWN_ITEMS_FIXTURE_IDS.storeAX,
      status: "pending",
      limit: 50,
    });

    // 2 pending rows at A.X: 1 barcode + 1 external_pos_id.
    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
      ].sort(),
    );

    // A.Y row is not visible to A.X-scoped operator (FR-014).
    expect(
      result.items.find(
        (r) => r.id === UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      ),
    ).toBeUndefined();

    // Cross-tenant rows obviously also absent.
    for (const r of result.items) {
      expect(r.tenantId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
      expect(r.storeId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.storeAX);
    }
  });

  it("store-scoped to A.Y sees A.Y rows only — A.X rows are invisible", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeId: UNKNOWN_ITEMS_FIXTURE_IDS.storeAY,
      status: "pending",
      limit: 50,
    });

    // 1 pending row at A.Y (barcode only — no external_pos_id seeded at A.Y).
    const ids = result.items.map((r) => r.id);
    expect(ids).toEqual([UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode]);
  });
});

// --------------------------------------------------------------------------
// SI-001 / SI-004 / FR-013 — cross-tenant probe is non-disclosing
// --------------------------------------------------------------------------

describe("T523 / 005-WAVE1-LIST — cross-tenant probe returns empty, not error", () => {
  it("tenant A listing with tenant A context never returns tenant B rows even by guess", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeId: null,
      status: "pending",
      limit: 50,
    });

    // RLS filters tenant B rows at the DB layer (003 unknown_items_tenant_isolation).
    // Service does not add an application-level tenant predicate.
    for (const r of result.items) {
      expect(r.tenantId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
    }

    // No "permission denied" or other oracle-leaking error — the page
    // is just filtered. (If RLS misbehaved this would throw or return
    // tenant B rows; both would fail the test.)
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("tenant-wide actor with a store_id from a DIFFERENT tenant returns empty (RLS filter, no error)", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    // Tenant A admin tries to narrow to tenant B's store. RLS filters
    // out B's rows; the empty page matches the non-disclosing posture
    // (indistinguishable from "no rows at that store in your tenant").
    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeId: UNKNOWN_ITEMS_FIXTURE_IDS.storeBX, // B's store, viewed from A
      status: "pending",
      limit: 50,
    });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
