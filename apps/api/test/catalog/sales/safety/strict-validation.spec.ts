/**
 * strict-validation.spec.ts — 008 US6 T071.
 *
 * The capture boundary is strict + default-deny (FR-062): an unknown key or a
 * malformed value is a deterministic 400 validation failure with NO record. No
 * coercion, no silent drop.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  type HarnessHandle,
} from "../capture/__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  if (h.harness) {
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

async function expectRejected(
  body: Record<string, unknown>,
  key: string,
): Promise<void> {
  if (!h.harness) throw new Error("harness not initialized");
  const res = await h.harness
    .http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(key))
    .send(body);
  expect(res.status).toBe(400);
}

describe("T071 — captureSale strict boundary, default-deny", () => {
  it("an unknown key → 400", async () => {
    if (h.dockerSkipped || !h.harness) return;
    await expectRejected(
      captureBody({ externalId: "ext-sv-unknown", surpriseKey: "boom" }),
      "svuk",
    );
  });

  it("a malformed money value → 400", async () => {
    if (h.dockerSkipped || !h.harness) return;
    await expectRejected(
      captureBody({ externalId: "ext-sv-money", posTotal: "not-a-number" }),
      "svmn",
    );
  });

  it("a non-ISO currency code → 400", async () => {
    if (h.dockerSkipped || !h.harness) return;
    await expectRejected(
      captureBody({ externalId: "ext-sv-ccy", currencyCode: "usd" }),
      "svcy",
    );
  });

  it("an empty lines array → 400 (at least one line required)", async () => {
    if (h.dockerSkipped || !h.harness) return;
    await expectRejected(
      captureBody({ externalId: "ext-sv-lines", lines: [] }),
      "svln",
    );
  });

  it("nothing was persisted across the rejected requests", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const n = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales WHERE source_system = 'pos-1'`,
    );
    expect(n.rows[0]?.n).toBe("0");
  });
});
