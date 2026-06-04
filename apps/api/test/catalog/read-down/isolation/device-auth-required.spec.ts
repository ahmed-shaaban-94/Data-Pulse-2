/**
 * device-auth-required.spec.ts — 010 US3-ISOLATION (T050).
 *
 * Both read-down routes require a resolved POS device principal (FR-001). US1
 * T036 proved this for the snapshot route inline; US3 is the cross-cutting
 * verify that adds the DELTA route and reads as the single isolation contract.
 *
 * Reuses the snapshot harness (the same ReadDownController serves both routes;
 * the ConfigurableContextGuard publishes / withholds the principal per test).
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
    console.warn("[device-auth-required.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// A valid `since` cursor for the delta route's happy path is irrelevant here —
// auth is checked before the cursor; any non-empty string reaches the guard.
const ANY_SINCE = "x";

describe("read-down isolation — device-auth required (T050)", () => {
  it("snapshot: unauthenticated (no resolved context) → 401 (FR-001)", async () => {
    if (skip()) return;
    h.harness!.contextGuard.anonymous = true;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(401);
  });

  it("delta: unauthenticated (no resolved context) → 401 (FR-001)", async () => {
    if (skip()) return;
    h.harness!.contextGuard.anonymous = true;
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since: ANY_SINCE });
    expect(res.status).toBe(401);
  });

  it("snapshot: a context with a null tenantId (manager-only, no device principal) → 401", async () => {
    if (skip()) return;
    // A manager Clerk JWT resolves a context with no tenant/store device
    // binding; the read-down routes reject it (device principal required).
    h.harness!.contextGuard.tenantId = null;
    h.harness!.contextGuard.storeId = null;
    const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(401);
  });

  it("delta: a context with a null tenantId → 401", async () => {
    if (skip()) return;
    h.harness!.contextGuard.tenantId = null;
    h.harness!.contextGuard.storeId = null;
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since: ANY_SINCE });
    expect(res.status).toBe(401);
  });
});
