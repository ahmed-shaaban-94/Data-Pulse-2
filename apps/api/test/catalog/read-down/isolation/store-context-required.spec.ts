/**
 * store-context-required.spec.ts — 010 US3-ISOLATION (T052).
 *
 * A device principal with no resolved store cannot read a store catalogue →
 * `store_context_required` (FR-005), reusing the existing POS error code. US1
 * T036 proved the snapshot side; US3 adds the delta route.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1. WSL-only.
 */
import {
  resetHarness,
  startSnapshotHarness,
  stopSnapshotHarness,
  type HarnessHandle,
} from "../snapshot/__snapshot-harness";

let h: HarnessHandle;

beforeAll(async () => {
  h = await startSnapshotHarness();
}, 180_000);
afterAll(async () => {
  await stopSnapshotHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

function skip(): boolean {
  if (!h.harness) {
    // eslint-disable-next-line no-console
    console.warn("[store-context-required.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

const ANY_SINCE = "x";

describe("read-down isolation — store context required (T052)", () => {
  it("snapshot: a principal with tenant but NO resolved store → store_context_required (FR-005)", async () => {
    if (skip()) return;
    h.harness!.contextGuard.storeId = null; // tenant resolved, store unresolved
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("store_context_required");
  });

  it("delta: a principal with tenant but NO resolved store → store_context_required", async () => {
    if (skip()) return;
    h.harness!.contextGuard.storeId = null;
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since: ANY_SINCE });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("store_context_required");
  });
});
