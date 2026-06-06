/**
 * 017-RECON-WIRING — `drainerProcessorProviderFactory` registration.
 *
 * Pins that the `erpnext.reconciliation.requested` consumer is wired into the
 * shared `OutboxConsumerRegistry` inside `drainerProcessorProviderFactory` — the
 * same seam that registers the 015 `PostingRequestedConsumer`, which holds BOTH
 * the pool and the (mutable) registry and runs during provider construction,
 * BEFORE `OutboxDrainerRunner.onModuleInit` starts the poll loop (no
 * register-after-drain race).
 *
 * Pure unit test — no Docker, no Postgres, no Nest boot. A fake pool object is
 * sufficient: the factory only stores the reference (it does not query at
 * registration time). The no-DB path (`pool === null`) must NOT register
 * (returns null; the consumer never sees a job because no jobs flow).
 */
import { OutboxConsumerRegistry } from "../../src/outbox/registry";
import { drainerProcessorProviderFactory } from "../../src/worker.module";
import { RECONCILIATION_REQUESTED_CONSUMER_ID } from "../../src/erpnext-reconciliation/reconciliation-requested.consumer";

// The AuditDbPool wrapper shape the factory reads: `.pool` (Pool | null).
function wrapper(pool: unknown): { pool: unknown } {
  return { pool };
}

describe("017-RECON-WIRING — drainer factory registers the reconciliation consumer", () => {
  it("registers erpnext.reconciliation.requested on the real-pool path", () => {
    const registry = new OutboxConsumerRegistry();
    // A non-null fake pool — the factory only stores the reference.
    const fakePool = {} as never;
    drainerProcessorProviderFactory(wrapper(fakePool) as never, registry);

    const consumer = registry.resolve("erpnext.reconciliation.requested");
    expect(consumer).toBeDefined();
    expect(consumer!.consumerId).toBe(RECONCILIATION_REQUESTED_CONSUMER_ID);
  });

  it("co-exists with the 015 posting consumer (both registered, no duplicate-type throw)", () => {
    const registry = new OutboxConsumerRegistry();
    drainerProcessorProviderFactory(wrapper({} as never) as never, registry);
    expect(registry.resolve("erpnext.posting.requested")).toBeDefined();
    expect(registry.resolve("erpnext.reconciliation.requested")).toBeDefined();
  });

  it("no-DB path (pool === null) returns null and registers nothing", () => {
    const registry = new OutboxConsumerRegistry();
    const result = drainerProcessorProviderFactory(wrapper(null) as never, registry);
    expect(result).toBeNull();
    expect(registry.resolve("erpnext.reconciliation.requested")).toBeUndefined();
  });
});
