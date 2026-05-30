/**
 * sales-sweep.spec.ts — 008 sale-fact cross-tenant/cross-store + RLS-bypass
 * isolation sweep (T015).
 *
 * Two kinds of assertion live here, by design (see the 008-ISOLATION-HARNESS
 * slice contract: "RED on missing capture/void/refund/read operations, NOT on
 * RLS"):
 *
 *   GROUP A — RLS / isolation (RUN + PASS NOW). With the seed-sales fixture
 *     populated across tenants A/B and stores X/Y, these prove the data-layer
 *     guarantee the slice exists to deliver: a wrong / unset `app.current_tenant`
 *     GUC returns ZERO rows from every sale-fact table, and a wrong-tenant GUC
 *     exposes only that tenant's rows. Run against `env.app` (the RLS-enforced
 *     non-superuser pool — NOT `env.admin`, which bypasses RLS). This is the
 *     first place 008 isolation is proven with rows ACTUALLY PRESENT in tenant A
 *     and invisible to tenant B (the migration round-trip proved fail-closed on
 *     EMPTY tables only).
 *
 *   GROUP B — operation sweep (RED NOW, on the unbuilt operation). The
 *     capture / void / refund / read API operations do not exist yet
 *     (008-US1-CAPTURE / US3 / US4 author the controller+service). These cases
 *     are scaffolded with a throwing placeholder that names the owning slice, so
 *     they FAIL on "operation not implemented" — NOT on an RLS leak — and are
 *     replaced with real object-level-authz / non-disclosing-404 assertions by
 *     T036 (capture), US3 (void), US4 (refund). No `SalesService` is imported at
 *     the top level: doing so would compile-error the whole file and prevent the
 *     Group A RLS probes (the slice's core deliverable) from running.
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned) — extend via seed-sales.ts.
 *
 * Transport: DB/RLS layer for Group A (no HTTP), mirroring the 003
 * `rls-bypass-probe.spec.ts` idiom (withRawClient + set_config LOCAL + ROLLBACK).
 */
import { type PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  TENANT_B,
} from "../../__support__/isolation-harness";
import { seedSalesFixture, SALES_FIXTURE_IDS } from "../__support__/seed-sales";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// A UUID never inserted into any fixture.
const NON_EXISTENT_TENANT = "0f000000-0000-7000-8000-00000000dead";

// The four 008 sale-fact tables.
const SALE_TABLES = ["sales", "sale_lines", "sale_voids", "sale_refunds"] as const;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env); // parent tenants/stores/actors
    await seedSalesFixture(env); // 008 sale-fact rows across A/B × X/Y
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[sales-sweep] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[sales-sweep] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/**
 * Acquire an `env.app` (RLS-enforced) client, wrap in BEGIN/ROLLBACK so the
 * LOCAL `set_config` GUC is discarded — no GUC bleed across tests.
 */
async function withRawClient<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await env!.app.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const F = SALES_FIXTURE_IDS;

// ===========================================================================
// GROUP A — RLS / isolation (RUN + PASS NOW)
// ===========================================================================

describe("sales-sweep §A.1 — wrong-tenant GUC exposes only that tenant's rows", () => {
  // Tenant B's GUC must NEVER surface tenant A's seeded rows, on any table.
  it.each(SALE_TABLES)(
    "%s: app.current_tenant = TENANT_B → zero TENANT_A rows visible",
    async (table) => {
      if (maybeSkip()) return;
      const rows = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          TENANT_B,
        ]);
        const r = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM ${table}`,
        );
        return r.rows;
      });
      // Every visible row belongs to B; none leak from A.
      for (const row of rows) {
        expect(row.tenant_id).toBe(TENANT_B);
      }
      expect(rows.filter((r) => r.tenant_id === TENANT_A)).toEqual([]);
    },
  );
});

describe("sales-sweep §A.2 — RLS-bypass probe: wrong tenant ⇒ zero rows on every table", () => {
  it.each(SALE_TABLES)(
    "%s: a non-existent app.current_tenant returns zero rows",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          NON_EXISTENT_TENANT,
        ]);
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );
});

describe("sales-sweep §A.3 — fail-closed: unset tenant GUC ⇒ zero rows on every table", () => {
  it.each(SALE_TABLES)(
    "%s: no app.current_tenant set returns zero rows (empty-GUC CASE guard)",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        // No set_config at all — current_setting('app.current_tenant', true)
        // returns '' → CASE guard yields NULL → NULL = tenant_id → row filtered.
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );
});

describe("sales-sweep §A.4 — in-scope baseline (anchors the sweep, prevents vacuous passes)", () => {
  // If these did NOT return rows, the §A.1-A.3 zero-row assertions could pass
  // vacuously (nothing seeded). This proves the fixture IS populated for A.
  it("TENANT_A GUC sees its own captured sale", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM sales WHERE id = $1`,
        [F.saleAX],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT_A);
  });

  it("TENANT_A GUC sees its own void + refund terminal rows", async () => {
    if (maybeSkip()) return;
    const { voids, refunds } = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const v = await client.query<{ id: string }>(
        `SELECT id FROM sale_voids WHERE id = $1`,
        [F.voidAX],
      );
      const rf = await client.query<{ id: string }>(
        `SELECT id FROM sale_refunds WHERE id = $1`,
        [F.refundAX],
      );
      return { voids: v.rows, refunds: rf.rows };
    });
    expect(voids).toHaveLength(1);
    expect(refunds).toHaveLength(1);
  });
});

// ===========================================================================
// GROUP B — operation sweep (RED NOW, on the unbuilt operation)
// ===========================================================================
//
// These prove the API-level object-safety contract (SI-001..005): unauthenticated
// → 401; cross-tenant id → non-disclosing 404; out-of-scope store → 404; body
// tenant_id/store_id/created_by ignored. They require the capture/void/refund/read
// operations, which do NOT exist yet. Each is scaffolded to FAIL on the missing
// operation (NOT on RLS) and will be replaced with real assertions by the owning
// slice. No SalesService import at module scope (would compile-error Group A).

/** Scaffold-RED: throws naming the owning slice. Replaced when the op lands. */
function pendingOperation(slice: string, op: string): never {
  throw new Error(
    `pending ${slice}: ${op} not implemented — replace this sweep case with a ` +
      `real object-level-authz / non-disclosing-404 assertion when the operation lands`,
  );
}

describe("sales-sweep §B — operation object-safety (RED until the operations exist)", () => {
  it("captureSale: cross-tenant read of a new sale → non-disclosing 404 (FR-102, SC-004) [008-US1-CAPTURE / T036]", () => {
    if (maybeSkip()) return;
    pendingOperation("008-US1-CAPTURE", "captureSale + readSale");
  });

  it("readSale: out-of-scope store id → non-disclosing 404 (FR-063, SI-004) [008-US1-CAPTURE / T036]", () => {
    if (maybeSkip()) return;
    pendingOperation("008-US1-CAPTURE", "readSale");
  });

  it("captureSale: body-supplied tenant_id/store_id/created_by ignored (FR-061) [008-US1-CAPTURE]", () => {
    if (maybeSkip()) return;
    pendingOperation("008-US1-CAPTURE", "captureSale mass-assignment guard");
  });

  it("recordVoid: cross-tenant sale ref → non-disclosing 404 (FR-014, SI-004) [008-US3-VOID]", () => {
    if (maybeSkip()) return;
    pendingOperation("008-US3-VOID", "recordVoid");
  });

  it("recordRefund: cross-tenant sale ref → non-disclosing 404 (FR-014, SI-004) [008-US4-REFUND]", () => {
    if (maybeSkip()) return;
    pendingOperation("008-US4-REFUND", "recordRefund");
  });

  it("unauthenticated capture/void/refund/read → 401 (SI authn) [008-US1-CAPTURE]", () => {
    if (maybeSkip()) return;
    pendingOperation("008-US1-CAPTURE", "unauthenticated 401 guard");
  });
});
