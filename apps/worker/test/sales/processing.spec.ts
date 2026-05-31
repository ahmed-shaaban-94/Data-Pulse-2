/**
 * T080 [TC] — Off-request sale-processing worker (008-WORKER).
 *
 * Proves the worker sets `processed_at` and computes the advisory mismatch flag
 * OFF-REQUEST (FR-071/081, §V):
 *   - it carries tenantId / storeId / correlationId on the job envelope;
 *   - it establishes tenant context (`app.current_tenant`) BEFORE any
 *     tenant-scoped DB access — the processor runs against the non-superuser
 *     `app` pool (rolbypassrls=false), so skipping tenant context would fail
 *     RLS. The "no tenant context fails RLS" sibling assertion pins that the
 *     app role genuinely cannot read/UPDATE `sales` without the GUC (the T561
 *     pattern), so the GREEN path is not passing trivially via a bypass.
 *   - it computes the mismatch flag with Postgres numeric (half-up), identical
 *     to capture — matching lines ⇒ false; a discrepancy ⇒ true. The POS total
 *     is read, never rewritten (FR-030).
 *
 * Docker/Testcontainers required. Soft-skips with MIGRATION_TEST_ALLOW_SKIP=1
 * when Docker is unavailable (this suite is NOT in jest.config's Docker-exclude
 * list because that file is outside the 008-WORKER allowed_files).
 */
import {
  applyAllUpAndCreateAppRole,
  APP_ROLE_NAME,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  SaleProcessingProcessor,
  SaleProcessingNotFoundError,
} from "../../src/sales/sale-processing.processor";
import { seedUnprocessedSale, readProcessingState } from "./__support__/seed";

// Hex-only UUID literals (memory: restrict mnemonic prefixes to a-f).
const TENANT_A = "5a1e0000-0000-7000-8000-0000000000a1";
const STORE_A = "5a1e0000-0000-7000-8000-0000000000b1";
const ACTOR_A = "5a1e0000-0000-7000-8000-0000000000c1";
const SALE_MATCH = "5a1e0000-0000-7000-8000-0000000000d1";
const SALE_MISMATCH = "5a1e0000-0000-7000-8000-0000000000d2";

const TENANT_B = "5a1e0000-0000-7000-8000-0000000000a2";
const STORE_B = "5a1e0000-0000-7000-8000-0000000000b2";
const ACTOR_B = "5a1e0000-0000-7000-8000-0000000000c2";
const SALE_B = "5a1e0000-0000-7000-8000-0000000000d3";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Matching sale: lines sum (40.00 + 60.00 = 100.0000) == pos_total.
    await seedUnprocessedSale(env.admin, {
      tenantId: TENANT_A,
      storeId: STORE_A,
      saleId: SALE_MATCH,
      actorId: ACTOR_A,
      slugSuffix: "a-match",
      currencyCode: "USD",
      posTotal: "100.00",
      lineAmounts: ["40.00", "60.00"],
      sourceSystem: "pos-x",
      externalId: "ext-match-1",
    });

    // Mismatching sale: lines sum (40.00 + 60.00 = 100.0000) != pos_total 99.50.
    await env.admin.query(
      `INSERT INTO sales
         (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
          business_date, source_system, external_id, payload_hash,
          processed_at, mismatch_flag, created_by)
       VALUES ($1, $2, $3, 'USD', '99.50'::numeric, now(),
               (now() AT TIME ZONE 'UTC')::date, 'pos-x', 'ext-mismatch-1',
               $4, NULL, NULL, $5)`,
      [SALE_MISMATCH, TENANT_A, STORE_A, "0".repeat(64), ACTOR_A],
    );
    for (const amt of ["40.00", "60.00"]) {
      await env.admin.query(
        `INSERT INTO sale_lines
           (id, sale_id, tenant_id, store_id, line_name, unit_price,
            currency_code, quantity, line_amount, unit, tenant_product_ref)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, 'USD',
                 '1'::numeric, $5::numeric, 'each', NULL)`,
        [SALE_MISMATCH, TENANT_A, STORE_A, `l-${amt}`, amt],
      );
    }

    // Tenant B sale (cross-tenant isolation probe).
    await seedUnprocessedSale(env.admin, {
      tenantId: TENANT_B,
      storeId: STORE_B,
      saleId: SALE_B,
      actorId: ACTOR_B,
      slugSuffix: "b-iso",
      currencyCode: "USD",
      posTotal: "10.00",
      lineAmounts: ["10.00"],
      sourceSystem: "pos-x",
      externalId: "ext-b-1",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[sales/processing.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
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
    console.warn("[sales/processing.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("T080: off-request sale processing sets processed_at + mismatch flag", () => {
  it("sets processed_at and mismatch_flag=false for a matching sale, under tenant context", async () => {
    if (maybeSkip()) return;

    const before = await readProcessingState(env!.admin, SALE_MATCH);
    expect(before.processedAt).toBeNull();
    expect(before.mismatchFlag).toBeNull();

    const processor = new SaleProcessingProcessor(env!.app);
    const result = await processor.process({
      saleId: SALE_MATCH,
      tenantId: TENANT_A,
      storeId: STORE_A,
      correlationId: "corr-match-1",
    });

    expect(result.saleId).toBe(SALE_MATCH);
    expect(result.applied).toBe(true);
    expect(result.mismatchFlag).toBe(false);
    expect(typeof result.processedAt).toBe("string");

    const after = await readProcessingState(env!.admin, SALE_MATCH);
    expect(after.processedAt).not.toBeNull();
    expect(after.mismatchFlag).toBe(false);
  });

  it("computes mismatch_flag=true when lines do not sum to the POS total", async () => {
    if (maybeSkip()) return;

    const processor = new SaleProcessingProcessor(env!.app);
    const result = await processor.process({
      saleId: SALE_MISMATCH,
      tenantId: TENANT_A,
      storeId: STORE_A,
      correlationId: "corr-mismatch-1",
    });

    expect(result.applied).toBe(true);
    expect(result.mismatchFlag).toBe(true);

    const after = await readProcessingState(env!.admin, SALE_MISMATCH);
    expect(after.mismatchFlag).toBe(true);
    // POS total never rewritten (FR-030).
    const pos = await env!.admin.query<{ pos_total: string }>(
      `SELECT pos_total FROM sales WHERE id = $1`,
      [SALE_MISMATCH],
    );
    expect(pos.rows[0]!.pos_total).toBe("99.5000");
  });

  it("FAILS RLS when the processor's connection has NO tenant context (proves §V)", async () => {
    if (maybeSkip()) return;

    // Direct UPDATE on the app pool with NO app.current_tenant GUC set: the
    // sales_tenant_update policy filters to zero rows / WITH CHECK denies, so
    // the row is invisible — proving the worker MUST establish tenant context
    // before DB access. (If this UPDATE could touch the row, the GREEN path
    // would be passing trivially.)
    const client = await env!.app.connect();
    try {
      const r = await client.query(
        `UPDATE sales SET processed_at = now() WHERE id = $1 RETURNING id`,
        [SALE_B],
      );
      expect(r.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it("does not disclose / process a sale outside the caller's tenant scope", async () => {
    if (maybeSkip()) return;

    // Processor bound to TENANT_A cannot resolve TENANT_B's sale → non-disclosing.
    const processor = new SaleProcessingProcessor(env!.app);
    await expect(
      processor.process({
        saleId: SALE_B,
        tenantId: TENANT_A,
        storeId: STORE_B,
        correlationId: "corr-cross-1",
      }),
    ).rejects.toBeInstanceOf(SaleProcessingNotFoundError);

    // TENANT_B's sale remains unprocessed.
    const state = await readProcessingState(env!.admin, SALE_B);
    expect(state.processedAt).toBeNull();
  });

  it("redacts: a failed-job log carries ONLY safe identifiers — no raw payload / amounts / row (FR-042/092)", async () => {
    if (maybeSkip()) return;

    // A well-formed but UNSEEDED sale id under a real tenant context: the
    // processor throws SaleProcessingNotFoundError and logs the failure.
    const MISSING = "5a1e0000-0000-7000-8000-0000000000ee";
    const logged: Array<Record<string, unknown>> = [];
    const logger = {
      error: (obj: Record<string, unknown>) => {
        logged.push(obj);
      },
    };
    const processor = new SaleProcessingProcessor(env!.app, logger);

    await expect(
      processor.process({
        saleId: MISSING,
        tenantId: TENANT_A,
        storeId: STORE_A,
        correlationId: "corr-redact-1",
      }),
    ).rejects.toBeInstanceOf(SaleProcessingNotFoundError);

    expect(logged).toHaveLength(1);
    const entry = logged[0]!;
    // The logged object's keys are EXACTLY the safe whitelist — no row data,
    // no payload, no money fields can leak.
    expect(Object.keys(entry).sort()).toEqual(
      [
        "correlation_id",
        "error_class",
        "job_name",
        "sale_id",
        "store_id",
        "tenant_id",
      ].sort(),
    );
    expect(entry["error_class"]).toBe("SaleProcessingNotFoundError");
    // Explicit negative guards against the PII/business-class fields FR-042/092
    // forbids in logs.
    for (const forbidden of [
      "pos_total",
      "posTotal",
      "line_amount",
      "lineAmount",
      "payload",
      "payload_hash",
      "lines",
    ]) {
      expect(entry).not.toHaveProperty(forbidden);
    }
    // And no value in the log serializes any of the seeded money strings.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("99.50");
    expect(serialized).not.toContain("100.00");
  });
});

describe("APP_ROLE_NAME sanity: app_test role has rolbypassrls=false", () => {
  it("confirms the RLS premise for T080 (no trivial bypass)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [APP_ROLE_NAME],
    );
    expect(r.rows[0]!.rolbypassrls).toBe(false);
  });
});
