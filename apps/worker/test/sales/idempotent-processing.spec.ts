/**
 * T081 [TC] — Idempotent off-request sale processing (008-WORKER).
 *
 * The outbox / job runtime is at-least-once: the same sale can be handed to the
 * processor more than once. FR-071 requires the SaaS-owned processing state to
 * be written ONCE and CONVERGE under retry — a re-run must not change the
 * recorded state.
 *
 * This spec runs the processor multiple times for the same sale and asserts:
 *   - the FIRST run reports `applied: true` and sets `processed_at`;
 *   - every SUBSEQUENT run reports `applied: false` (no write);
 *   - `processed_at` is BYTE-IDENTICAL across runs (no timestamp drift — the
 *     trap if the UPDATE were unguarded and stamped now() every time);
 *   - `mismatch_flag` is identical across runs.
 *
 * Docker/Testcontainers required; soft-skips with MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { SaleProcessingProcessor } from "../../src/sales/sale-processing.processor";
import { seedUnprocessedSale, readProcessingState } from "./__support__/seed";

const TENANT = "5a1ed000-0000-7000-8000-0000000000a1";
const STORE = "5a1ed000-0000-7000-8000-0000000000b1";
const ACTOR = "5a1ed000-0000-7000-8000-0000000000c1";
const SALE = "5a1ed000-0000-7000-8000-0000000000d1";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedUnprocessedSale(env.admin, {
      tenantId: TENANT,
      storeId: STORE,
      saleId: SALE,
      actorId: ACTOR,
      slugSuffix: "idem",
      currencyCode: "USD",
      posTotal: "25.00",
      lineAmounts: ["10.00", "15.00"],
      sourceSystem: "pos-x",
      externalId: "ext-idem-1",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[sales/idempotent-processing.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[sales/idempotent-processing.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("T081: re-running the processor converges to the same state (idempotent)", () => {
  it("processes once, then re-runs converge with no processed_at drift", async () => {
    if (maybeSkip()) return;

    const processor = new SaleProcessingProcessor(env!.app);

    const first = await processor.process({
      saleId: SALE,
      tenantId: TENANT,
      storeId: STORE,
      correlationId: "corr-idem-1",
    });
    expect(first.applied).toBe(true);
    expect(first.mismatchFlag).toBe(false); // 10 + 15 == 25

    const afterFirst = await readProcessingState(env!.admin, SALE);
    expect(afterFirst.processedAt).not.toBeNull();
    const firstProcessedAtMs = afterFirst.processedAt!.getTime();

    // Re-run ×3 (at-least-once re-delivery).
    for (let i = 0; i < 3; i++) {
      const rerun = await processor.process({
        saleId: SALE,
        tenantId: TENANT,
        storeId: STORE,
        correlationId: `corr-idem-rerun-${i}`,
      });
      // Converges: no write, same flag, same processed_at echoed.
      expect(rerun.applied).toBe(false);
      expect(rerun.mismatchFlag).toBe(false);
      expect(rerun.processedAt).toBe(first.processedAt);
    }

    // The persisted state did NOT drift across re-runs.
    const afterReruns = await readProcessingState(env!.admin, SALE);
    expect(afterReruns.processedAt!.getTime()).toBe(firstProcessedAtMs);
    expect(afterReruns.mismatchFlag).toBe(false);
  });
});
