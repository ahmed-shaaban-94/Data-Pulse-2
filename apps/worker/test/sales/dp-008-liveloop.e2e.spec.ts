/**
 * DP-008-LIVELOOP [TC] — end-to-end "make the live loop live" (Slice 2).
 *
 * Proves the full capture → process loop end-to-end against a real Postgres:
 *
 *   emit `sale.captured` (in-tx, app role + tenant GUC)   ← capture half
 *     → DrainerProcessor.tick() claims the pending outbox row
 *       → SaleCapturedConsumer.handle() maps it to a "sale-processing" job
 *         → SaleProcessingProcessor.process(job) sets processed_at + mismatch
 *
 * and that re-running the processor is idempotent (`processed_at` is stable).
 *
 * Package boundary (deliberate)
 * -----------------------------
 * Worker tests MUST NOT import from `apps/api` (separate package — see
 * `apps/worker/test/sales/__support__/seed.ts`). So this spec does NOT call
 * `SalesService.captureSale`; it replicates the capture-side emit inline with
 * the SAME real `emit(client, ...)` helper from `@data-pulse-2/db`, inside a
 * `runWithTenantContext` callback that also seeds the sale + lines — exactly
 * the atomic shape the service now uses. The capture-side emit's own branch
 * logic (created-path-only, IDs-only payload, rollback-on-failure) is unit-
 * covered in `apps/api/test/catalog/sales/sales.unit.spec.ts`; this spec proves
 * the emit→drain→consume→process→idempotent mechanics that unit tests can't.
 *
 * No Redis
 * --------
 * `PgTestEnv` is Postgres-only; there is no Redis/BullMQ testcontainer helper.
 * The BullMQ glue (`SaleWorker`) is covered by `sale.worker.spec.ts`. Here the
 * `SaleCapturedConsumer` is injected with a SPY `SaleProcessingQueueLike` that
 * captures the enqueued job; we then drive `SaleProcessingProcessor.process()`
 * directly on that job — the same logical hop BullMQ would make, no Redis.
 *
 * Docker/Testcontainers required. Soft-skips with MIGRATION_TEST_ALLOW_SKIP=1
 * when Docker is unavailable. This suite IS in jest.config's Docker-exclude
 * list (the fast no-Docker job skips it; the db-integration job runs it).
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { runWithTenantContext, emit, OUTBOX_EVENT_TYPES } from "@data-pulse-2/db";
import { DrainerProcessor } from "../../src/outbox/drainer.processor";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";
import {
  SaleCapturedConsumer,
  type SaleProcessingQueueLike,
  OUTBOX_SALE_PROCESSING_JOB_NAME,
} from "../../src/outbox/consumers/sale-captured.consumer";
import {
  SaleProcessingProcessor,
  type SaleProcessingJob,
} from "../../src/sales/sale-processing.processor";
import { seedUnprocessedSale, readProcessingState } from "./__support__/seed";

// Hex-only UUID literals (memory: restrict mnemonic prefixes to a-f).
const TENANT = "e2e00000-0000-7000-8000-0000000000a1";
const STORE = "e2e00000-0000-7000-8000-0000000000b1";
const ACTOR = "e2e00000-0000-7000-8000-0000000000c1";
const SALE = "e2e00000-0000-7000-8000-0000000000d1";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Seed a captured-but-unprocessed sale (processed_at / mismatch_flag NULL),
    // exactly the state the 008 capture path leaves. Lines sum (40 + 60 = 100)
    // == pos_total, so the processor must compute mismatch_flag = false.
    await seedUnprocessedSale(env.admin, {
      tenantId: TENANT,
      storeId: STORE,
      saleId: SALE,
      actorId: ACTOR,
      slugSuffix: "e2e-liveloop",
      currencyCode: "USD",
      posTotal: "100.00",
      lineAmounts: ["40.00", "60.00"],
      sourceSystem: "pos-e2e",
      externalId: "ext-e2e-1",
    });

    // Capture-side emit, replicated inline with the REAL emit() under the app
    // role + tenant GUC — proving the outbox RLS WITH CHECK passes (same path
    // the service now runs). IDs-only payload (sale_id / store_id).
    await runWithTenantContext(
      env.app,
      { tenantId: TENANT, isPlatformAdmin: false },
      async (client) => {
        await emit(client, {
          eventType: OUTBOX_EVENT_TYPES.SALE_CAPTURED,
          tenantId: TENANT,
          storeId: STORE,
          payload: { sale_id: SALE, store_id: STORE },
          correlationId: null,
        });
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[sales/dp-008-liveloop.e2e] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[sales/dp-008-liveloop.e2e] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("DP-008-LIVELOOP: capture → drain → consume → process, end-to-end", () => {
  it("drives the live loop and processes the sale; re-processing is idempotent", async () => {
    if (maybeSkip()) return;

    // --- Capture half asserted: exactly one pending sale.captured row, with a
    // processed_at-NULL sale waiting for it. -------------------------------
    const pending = await env!.admin.query<{
      event_type: string;
      delivery_state: string;
      payload: { sale_id: string; store_id: string };
    }>(
      `SELECT event_type, delivery_state, payload FROM outbox_events
        WHERE event_type = $1`,
      [OUTBOX_EVENT_TYPES.SALE_CAPTURED],
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]!.delivery_state).toBe("pending");
    expect(pending.rows[0]!.payload).toEqual({ sale_id: SALE, store_id: STORE });

    const before = await readProcessingState(env!.admin, SALE);
    expect(before.processedAt).toBeNull();
    expect(before.mismatchFlag).toBeNull();

    // --- Drain half: spy queue captures the enqueued job; the real consumer is
    // registered and the real drainer claims+dispatches the pending row. ----
    const enqueued: Array<{ name: string; data: SaleProcessingJob }> = [];
    const spyQueue: SaleProcessingQueueLike = {
      async add(name: string, data: unknown): Promise<unknown> {
        enqueued.push({ name, data: data as SaleProcessingJob });
        return undefined;
      },
    };

    const registry = new OutboxConsumerRegistry();
    registry.register(new SaleCapturedConsumer(spyQueue));

    // Default claimBatch (the production claim path) — the fresh container has
    // exactly one pending row, so the drainer claims precisely this event.
    const drainer = new DrainerProcessor({ pool: env!.admin, registry });
    await drainer.tick();

    // The outbox row transitioned to delivered, and a sale-processing job was
    // enqueued carrying the envelope tenant + payload ids.
    const afterDrain = await env!.admin.query<{ delivery_state: string }>(
      `SELECT delivery_state FROM outbox_events WHERE event_type = $1`,
      [OUTBOX_EVENT_TYPES.SALE_CAPTURED],
    );
    expect(afterDrain.rows[0]!.delivery_state).toBe("delivered");

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe(OUTBOX_SALE_PROCESSING_JOB_NAME);
    const job = enqueued[0]!.data;
    expect(job).toEqual(
      expect.objectContaining({
        saleId: SALE,
        tenantId: TENANT,
        storeId: STORE,
      }),
    );

    // --- Process half: run the processor on the enqueued job (the hop BullMQ
    // would make). Sets processed_at + mismatch_flag under tenant context. --
    const processor = new SaleProcessingProcessor(env!.app);
    const first = await processor.process(job);
    expect(first.applied).toBe(true);
    expect(first.mismatchFlag).toBe(false); // 40 + 60 == 100

    const afterProcess = await readProcessingState(env!.admin, SALE);
    expect(afterProcess.processedAt).not.toBeNull();
    expect(afterProcess.mismatchFlag).toBe(false);

    // --- Idempotency: re-processing the same job is a no-op; processed_at is
    // stable, mismatch unchanged (FR-071 / §XI convergence). ----------------
    const second = await processor.process(job);
    expect(second.applied).toBe(false);
    expect(second.processedAt).toBe(first.processedAt);

    const afterReprocess = await readProcessingState(env!.admin, SALE);
    expect(afterReprocess.processedAt!.toISOString()).toBe(
      afterProcess.processedAt!.toISOString(),
    );
    expect(afterReprocess.mismatchFlag).toBe(false);
  });
});
