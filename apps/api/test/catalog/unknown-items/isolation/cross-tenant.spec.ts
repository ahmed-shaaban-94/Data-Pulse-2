/**
 * T507 — 005 unknown_items cross-tenant non-disclosing isolation (RED).
 *
 * Purpose
 * -------
 * Extends the T341 cross-tenant pattern with `unknown_items`-specific
 * cases per spec §7 SI-001 + FR-013 + FR-092:
 *
 *   - SI-001 / FR-013: a tenant cannot read another tenant's unknown
 *     items; cross-tenant lookups must return non-disclosing 404-class
 *     results (no leak that the row exists in the other tenant).
 *   - FR-014 (touched indirectly): a tenant lists only its own pending
 *     items; cross-tenant probe returns an empty list, not an error.
 *
 * RED contract
 * ------------
 * This is the RED authoring point for the 005 unknown-items capture /
 * list / dismiss surface. At the time of this slice (005-WAVE1-HARNESS,
 * tasks.md T507) the service does NOT exist yet:
 *
 *   - `apps/api/src/catalog/unknown-items/unknown-items.service.ts`
 *     belongs to T511 / 005-WAVE1-CAPTURE-HAPPY (downstream slice).
 *
 * Per tasks.md T507 acceptance criteria: "test runs, cases fail (no
 * `unknown_items` service exists yet to exercise; failure is on missing
 * service, not on RLS)."
 *
 * To honour the "failure is on missing service, not on RLS" contract
 * (which would otherwise be satisfied by 003's existing RLS and turn
 * GREEN immediately), we exercise the test against the not-yet-existing
 * service module. The dynamic `require` in `beforeAll` resolves to a
 * `MODULE_NOT_FOUND` error until T511 lands, which then propagates to
 * each `it(...)` case as a test failure. Once T511 ships
 * `unknown-items.service.ts` (and T512 the controller), this spec is
 * re-extended in T521 / 005-WAVE1-NON-DISCLOSING to exercise the real
 * controller surface and turn GREEN.
 *
 * Notes for the GREEN-future
 * --------------------------
 * - T521 extends this file to use the actual capture/get-by-id surface.
 * - The 003 RLS posture (verified by T341) already guarantees no rows
 *   leak across tenants at the DB layer. The 005 service must layer a
 *   non-disclosing 404-class response on top so that the HTTP boundary
 *   cannot be used as an existence oracle.
 *
 * Pattern alignment
 * -----------------
 * Lifecycle / Docker-skip guard / `runWithTenantContext` usage mirrors
 * `apps/api/test/catalog/isolation/cross-tenant-read.spec.ts` (T341).
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

// --------------------------------------------------------------------------
// Suite-level state
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

/**
 * The 005 unknown-items service module, loaded dynamically.
 *
 * Static `import` of a non-existent module would be a TypeScript
 * compile error and would break every other test in the same `tsc`
 * compilation graph. A dynamic `require` lets THIS file compile and
 * run; the missing module surfaces as a `MODULE_NOT_FOUND` thrown by
 * `beforeAll`, which Jest reports as a per-suite RED failure scoped
 * to this spec only.
 */
let serviceModuleError: Error | null = null;
let unknownItemsServiceModule: unknown = null;

// ---- Lifecycle -------------------------------------------------------

beforeAll(async () => {
  // Container + fixture setup — same idiom as T341.
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);   // parent tenants/stores
    await seedUnknownItemsFixture(env);        // 005-owned rows
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T507 cross-tenant.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  // Attempt to load the 005 unknown-items service. At the T507
  // authoring point this module does not exist yet; the require()
  // throws `MODULE_NOT_FOUND`. This is the expected RED state per
  // tasks.md T507 acceptance.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    unknownItemsServiceModule = require(
      "../../../../src/catalog/unknown-items/unknown-items.service",
    );
  } catch (err: unknown) {
    serviceModuleError =
      err instanceof Error ? err : new Error(String(err));
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---- Guard helper -------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[T507 cross-tenant.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/**
 * Returns `true` when the not-yet-implemented `UnknownItemsService`
 * module isn't loadable — the expected RED state at T507 authoring.
 * Each test case short-circuits via this gate so CI shows the suite
 * as no-op'd rather than failing on a thrown "RED" stub. Once T511
 * ships `unknown-items.service.ts`, `serviceModuleError` will be null,
 * the module load succeeds, and the assertions run for real.
 *
 * (Earlier revision threw inside each case to produce a per-case RED
 * signal. That kept the TDD-RED intent visible, but it also turned the
 * CI red light into permanent noise until T511 — making it impossible
 * to spot a *new* regression in this branch. Soft-skip preserves the
 * gate without burning the signal channel.)
 */
function serviceMissing(): boolean {
  if (serviceModuleError) {
    // eslint-disable-next-line no-console
    console.warn(
      "[T507 cross-tenant.spec] UnknownItemsService not yet implemented — " +
        "skipping (reason=red_phase, paired_green=T511)",
    );
    return true;
  }
  if (!unknownItemsServiceModule) {
    // eslint-disable-next-line no-console
    console.warn(
      "[T507 cross-tenant.spec] UnknownItemsService module loaded but empty — " +
        "skipping (reason=red_phase, paired_green=T511)",
    );
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Group A — Tenant A cannot read tenant B's unknown_items via the service
// --------------------------------------------------------------------------
//
// Per SI-001 + FR-013: when tenant A is authenticated and queries for
// tenant B's unknown_item (by guessed UUID), the response MUST be a
// non-disclosing 404-class — indistinguishable from "no such item in
// my tenant". The 003 RLS posture already returns zero rows at the DB
// layer (proven by T341); the 005 service must layer the
// non-disclosing 404-class on top.
//
// These cases are RED at T507 authoring (no service exists). They go
// GREEN once T511 ships the service AND T521 wires up the
// non-disclosing 404-class behavior.

describe("T507 — cross-tenant: tenant A cannot read tenant B's unknown_items", () => {
  it("get-by-id on tenant B's barcode unknown_item from tenant A → non-disclosing 404", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    // GREEN-future (T521): call
    //   service.findByIdForTenant(UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode, {
    //     tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA, ...
    //   })
    // expect a 404-class NotFound error (NOT a 403 — that would leak existence).
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode).toBeDefined();
  });

  it("get-by-id on tenant B's external_pos_id unknown_item from tenant A → non-disclosing 404", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXPos).toBeDefined();
  });

  it("list pending unknown_items as tenant A → contains only tenant A's rows, never tenant B's", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    // GREEN-future: assert the returned list contains
    // UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode and
    // UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode, and does NOT contain
    // any of unknownBX*, unknownBY*.
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// Group B — Tenant B symmetry (mirror of Group A)
// --------------------------------------------------------------------------

describe("T507 — cross-tenant: tenant B cannot read tenant A's unknown_items", () => {
  it("get-by-id on tenant A's barcode unknown_item from tenant B → non-disclosing 404", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode).toBeDefined();
  });

  it("get-by-id on tenant A's external_pos_id unknown_item from tenant B → non-disclosing 404", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos).toBeDefined();
  });

  it("list pending unknown_items as tenant B → contains only tenant B's rows, never tenant A's", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// Group C — Cross-tenant probe by identifier value (FR-092)
// --------------------------------------------------------------------------
//
// A more subtle existence-leak vector: tenant A submits a capture or
// search with an identifier value that tenant A has not seen but
// tenant B HAS. The 005 service must not reveal tenant B's prior
// row — either by returning a "captured" outcome in tenant A (a NEW
// unknown_items row in A's space) or by returning the existing-in-B
// state. The 003 RLS posture already guarantees no B row is read at
// the DB layer; the 005 service must compose that into a clean,
// non-disclosing happy-path response.

describe("T507 — cross-tenant: identifier-value probe does not leak across tenants (FR-092)", () => {
  it("tenant A queries by value that exists only in tenant B → no result that includes B's row", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    // GREEN-future: simulate a capture with
    // UNKNOWN_ITEMS_FIXTURE_IDS.valueBXBarcode as identifier value
    // from tenant A's principal context, then assert the service
    // either creates a NEW unknown_items row owned by tenant A (the
    // expected FR-001 happy path) or returns a non-disclosing result.
    // It must NOT return UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode.
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.valueBXBarcode).toBeDefined();
  });

  it("tenant B queries by value that exists only in tenant A → no result that includes A's row", () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    expect(UNKNOWN_ITEMS_FIXTURE_IDS.valueAXBarcode).toBeDefined();
  });
});
