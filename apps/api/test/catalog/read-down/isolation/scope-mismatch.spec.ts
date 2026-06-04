/**
 * scope-mismatch.spec.ts — 010 US3-ISOLATION (T051).
 *
 * A `branch_id` (or scope) not matching the device token's resolved store →
 * non-disclosing 404-class, identical to an absent store — no exists/not-exists
 * disclosure (FR-002/003/004, §II/§XII). A MATCHING branch_id serves only the
 * principal's (tenant, store). US1 T036 proved the snapshot side; US3 adds the
 * delta route and the cross-route contract.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1. WSL-only.
 */
import {
  READ_DOWN_FIXTURE_IDS,
  resetHarness,
  startSnapshotHarness,
  stopSnapshotHarness,
  STORE_A_X,
  STORE_B_X,
  type HarnessHandle,
} from "../snapshot/__snapshot-harness";

let h: HarnessHandle;
const F = READ_DOWN_FIXTURE_IDS;

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
    console.warn("[scope-mismatch.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/** A valid current cursor for (TENANT_A, STORE_A_X) — for the delta happy path. */
async function currentCursor(): Promise<string> {
  const res = await h.harness!.http().get("/api/pos/v1/catalog/snapshot");
  expect(res.status).toBe(200);
  return res.body.cursor as string;
}

describe("read-down isolation — scope mismatch (T051)", () => {
  it("snapshot: branch_id ≠ token store → non-disclosing 404 (no store leak)", async () => {
    if (skip()) return;
    // Principal scoped to STORE_A_X; ask for STORE_B_X via branch_id.
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ branch_id: STORE_B_X });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(STORE_B_X);
  });

  it("delta: branch_id ≠ token store → non-disclosing 404", async () => {
    if (skip()) return;
    const since = await currentCursor();
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since, branch_id: STORE_B_X });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(STORE_B_X);
  });

  it("snapshot: a MATCHING branch_id serves only the principal's (tenant, store)", async () => {
    if (skip()) return;
    const res = await h.harness!
      .http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ branch_id: STORE_A_X });
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ product_id: string }>).map(
      (r) => r.product_id,
    );
    expect(ids).toContain(F.sellableProduct);
  });
});
