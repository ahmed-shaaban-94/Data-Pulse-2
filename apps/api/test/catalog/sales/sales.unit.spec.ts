/**
 * sales.unit.spec.ts — 008 US1 Docker-free unit coverage for the capture
 * controller + service branch logic (no Testcontainers).
 *
 * The HTTP/RLS behavior is proven by the Testcontainers capture + sweep suites;
 * this spec exercises the in-process branches those suites can't drive
 * deterministically (the ON CONFLICT loser + defensive throw, the optional
 * outbox enqueue, the read-projection nullish fallbacks, and the controller's
 * guard / rethrow paths) by mocking the pg client and the tenant-context runner.
 */
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

// runWithTenantContext is mocked to invoke its callback with a scripted client,
// so the service runs entirely in-process with no database.
let clientQuery: jest.Mock;
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: (
    _pool: unknown,
    _ctx: unknown,
    fn: (c: { query: jest.Mock }) => unknown,
  ) => fn({ query: clientQuery }),
}));

import {
  SalesService,
  SaleNotFoundError,
  TerminalEventProvenanceConflictError,
  type SalesOutboxProducer,
} from "../../../src/catalog/sales/sales.service";
import { SalesController } from "../../../src/catalog/sales/sales.controller";

const VALID_REF = "0d000000-0000-7000-8000-0000000000a1";

function body(overrides: Record<string, unknown> = {}): any {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-1",
    currencyCode: "USD",
    posTotal: "12.5000",
    occurredAt: "2026-05-01T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "12.5000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "12.5000",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

/** A `sales` row as the read projection expects it from pg. */
function saleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALID_REF,
    store_id: "0d000000-0000-7000-8000-0000000000b1",
    currency_code: "USD",
    pos_total: "12.5000",
    occurred_at: new Date("2026-05-01T10:00:00.000Z"),
    received_at: new Date("2026-05-01T10:00:01.000Z"),
    business_date: "2026-05-01",
    processed_at: null,
    source_clock_at: null,
    source_system: "pos-1",
    external_id: "ext-1",
    mismatch_flag: null,
    ...overrides,
  };
}

const CAPTURE = {
  tenantId: "0d000000-0000-7000-8000-0000000000c1",
  storeId: "0d000000-0000-7000-8000-0000000000b1",
  actorUserId: "0d000000-0000-7000-8000-0000000000d1",
};

/**
 * Route a scripted client.query by SQL shape so one mock serves both the
 * capture transaction and the subsequent read-projection transaction.
 */
function scriptClient(opts: {
  mismatchRows?: Array<{ mismatch: boolean }>;
  insertedRows?: Array<{ id: string }>;
  winnerRows?: Array<{ id: string }>;
  saleRows?: Array<Record<string, unknown>>;
  lineRows?: Array<Record<string, unknown>>;
}): jest.Mock {
  return jest.fn(async (sql: string) => {
    if (/SUM\(amt\)/.test(sql)) return { rows: opts.mismatchRows ?? [{ mismatch: false }] };
    if (/INSERT INTO sales/.test(sql)) return { rows: opts.insertedRows ?? [{ id: VALID_REF }] };
    if (/SELECT id FROM sales/.test(sql)) return { rows: opts.winnerRows ?? [] };
    if (/INSERT INTO sale_lines/.test(sql)) return { rows: [] };
    if (/FROM sales WHERE id/.test(sql)) return { rows: opts.saleRows ?? [saleRow()] };
    if (/FROM sale_lines WHERE sale_id/.test(sql)) return { rows: opts.lineRows ?? [] };
    throw new Error(`unscripted query: ${sql}`);
  });
}

describe("SalesService — capture branches (unit)", () => {
  it("fresh capture inserts, enqueues the outbox event, returns created=true", async () => {
    clientQuery = scriptClient({ insertedRows: [{ id: VALID_REF }] });
    const outbox: SalesOutboxProducer = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const svc = new SalesService({} as never, outbox);

    const res = await svc.captureSale({ ...CAPTURE, body: body() });

    expect(res.created).toBe(true);
    expect(res.projection.saleRef).toBe(VALID_REF);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sale.captured" }),
    );
  });

  it("created=true without an outbox producer does not throw (optional seam)", async () => {
    clientQuery = scriptClient({});
    const svc = new SalesService({} as never); // no outbox
    const res = await svc.captureSale({ ...CAPTURE, body: body() });
    expect(res.created).toBe(true);
  });

  it("a swallowed outbox failure still returns the created sale", async () => {
    clientQuery = scriptClient({});
    const outbox: SalesOutboxProducer = {
      enqueue: jest.fn().mockRejectedValue(new Error("queue down")),
    };
    const svc = new SalesService({} as never, outbox);
    const res = await svc.captureSale({ ...CAPTURE, body: body() });
    expect(res.created).toBe(true);
  });

  it("ON CONFLICT (zero rows) resolves to the existing row, created=false", async () => {
    clientQuery = scriptClient({ insertedRows: [], winnerRows: [{ id: VALID_REF }] });
    const outbox: SalesOutboxProducer = { enqueue: jest.fn() };
    const svc = new SalesService({} as never, outbox);

    const res = await svc.captureSale({ ...CAPTURE, body: body() });

    expect(res.created).toBe(false);
    expect(res.projection.saleRef).toBe(VALID_REF);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("ON CONFLICT but the winner row cannot be re-read → throws (defensive)", async () => {
    clientQuery = scriptClient({ insertedRows: [], winnerRows: [] });
    const svc = new SalesService({} as never);
    await expect(svc.captureSale({ ...CAPTURE, body: body() })).rejects.toThrow(
      /dedup conflict/,
    );
  });

  it("an empty comparison result defaults mismatch_flag to false", async () => {
    clientQuery = scriptClient({ mismatchRows: [] });
    const svc = new SalesService({} as never);
    const res = await svc.captureSale({ ...CAPTURE, body: body() });
    expect(res.created).toBe(true);
  });
});

describe("SalesService — readSaleProjection branches (unit)", () => {
  it("an absent row is a SaleNotFoundError (non-disclosing)", async () => {
    clientQuery = scriptClient({ saleRows: [] });
    const svc = new SalesService({} as never);
    await expect(
      svc.readSaleProjection(CAPTURE.tenantId, CAPTURE.storeId, VALID_REF),
    ).rejects.toBeInstanceOf(SaleNotFoundError);
  });

  it("maps a fully-populated row (Date business_date, non-null timestamps, mismatch)", async () => {
    clientQuery = scriptClient({
      saleRows: [
        saleRow({
          business_date: new Date("2026-05-01T00:00:00.000Z"),
          processed_at: new Date("2026-05-02T00:00:00.000Z"),
          source_clock_at: new Date("2026-05-01T09:59:00.000Z"),
          mismatch_flag: true,
        }),
      ],
      lineRows: [
        {
          line_name: "Widget",
          unit_price: "12.5000",
          currency_code: "USD",
          quantity: "1",
          line_amount: "12.5000",
          tax_amount: null,
          unit: "ea",
          tenant_product_ref: null,
        },
      ],
    });
    const svc = new SalesService({} as never);
    const p = await svc.readSaleProjection(CAPTURE.tenantId, CAPTURE.storeId, VALID_REF);
    expect(p.businessDate).toBe("2026-05-01");
    expect(p.processedAt).not.toBeNull();
    expect(p.sourceClockAt).not.toBeNull();
    expect(p.mismatchFlag).toBe(true);
    expect(p.lines).toHaveLength(1);
  });

  it("maps a minimal row (string business_date, null timestamps, null mismatch)", async () => {
    clientQuery = scriptClient({ saleRows: [saleRow()] });
    const svc = new SalesService({} as never);
    const p = await svc.readSaleProjection(CAPTURE.tenantId, CAPTURE.storeId, VALID_REF);
    expect(p.businessDate).toBe("2026-05-01");
    expect(p.processedAt).toBeNull();
    expect(p.sourceClockAt).toBeNull();
    expect(p.mismatchFlag).toBe(false);
  });
});

describe("SalesController — guard + status branches (unit)", () => {
  function makeRes(): { status: jest.Mock; setHeader: jest.Mock } {
    return { status: jest.fn(), setHeader: jest.fn() };
  }
  const ctx = { tenantId: CAPTURE.tenantId, storeId: CAPTURE.storeId, userId: CAPTURE.actorUserId };

  it("captureSale: missing context → 401", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale({ context: undefined } as never, body() as never, makeRes() as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: null tenantId → 401", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale(
        { context: { ...ctx, tenantId: null } } as never,
        body() as never,
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: null userId → 401", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale(
        { context: { ...ctx, userId: null } } as never,
        body() as never,
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: null storeId → 401 (store_context_required)", async () => {
    const c = new SalesController({} as never);
    await expect(
      c.captureSale(
        { context: { ...ctx, storeId: null } } as never,
        body() as never,
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("readSale: null tenantId → 401", async () => {
    const c = new SalesController({ readSaleProjection: jest.fn() } as never);
    await expect(
      c.readSale({ context: { ...ctx, tenantId: null } } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("captureSale: created → 201; replay → 200 + replay header", async () => {
    const svc = {
      captureSale: jest
        .fn()
        .mockResolvedValueOnce({ created: true, projection: { saleRef: VALID_REF } })
        .mockResolvedValueOnce({ created: false, projection: { saleRef: VALID_REF } }),
    };
    const c = new SalesController(svc as never);

    const res1 = makeRes();
    await c.captureSale({ context: ctx } as never, body() as never, res1 as never);
    expect(res1.status).toHaveBeenCalledWith(201);

    const res2 = makeRes();
    await c.captureSale({ context: ctx } as never, body() as never, res2 as never);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
  });

  it("readSale: missing context → 401, null store → 401, bad ref → 404", async () => {
    const c = new SalesController({ readSaleProjection: jest.fn() } as never);
    await expect(
      c.readSale({ context: undefined } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      c.readSale({ context: { ...ctx, storeId: null } } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      c.readSale({ context: ctx } as never, "not-a-uuid"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("readSale: SaleNotFoundError → 404; any other error rethrows", async () => {
    const notFound = new SalesController({
      readSaleProjection: jest.fn().mockRejectedValue(new SaleNotFoundError()),
    } as never);
    await expect(notFound.readSale({ context: ctx } as never, VALID_REF)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const boom = new SalesController({
      readSaleProjection: jest.fn().mockRejectedValue(new Error("db exploded")),
    } as never);
    await expect(boom.readSale({ context: ctx } as never, VALID_REF)).rejects.toThrow(
      /db exploded/,
    );
  });

  const voidBody = { sourceSystem: "pos-1", externalId: "v" };

  it("recordVoid: missing ctx / null tenant / null actor / null store → 401; bad ref → 404", async () => {
    const c = new SalesController({ recordVoid: jest.fn() } as never);
    for (const badCtx of [
      { context: undefined },
      { context: { ...ctx, tenantId: null } },
      { context: { ...ctx, userId: null } },
      { context: { ...ctx, storeId: null } },
    ]) {
      await expect(
        c.recordVoid(badCtx as never, VALID_REF, voidBody as never, makeRes() as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      c.recordVoid({ context: ctx } as never, "not-a-uuid", voidBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("recordVoid: created → 201; replay → 200 + replay header", async () => {
    const projection = { eventRef: "e", saleRef: VALID_REF, kind: "void" };
    const svc = {
      recordVoid: jest
        .fn()
        .mockResolvedValueOnce({ created: true, projection })
        .mockResolvedValueOnce({ created: false, projection }),
    };
    const c = new SalesController(svc as never);

    const r1 = makeRes();
    await c.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, r1 as never);
    expect(r1.status).toHaveBeenCalledWith(201);

    const r2 = makeRes();
    await c.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, r2 as never);
    expect(r2.status).toHaveBeenCalledWith(200);
    expect(r2.setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
  });

  it("recordVoid: SaleNotFoundError → 404; ProvenanceConflict → 409; other rethrows", async () => {
    const nf = new SalesController({
      recordVoid: jest.fn().mockRejectedValue(new SaleNotFoundError()),
    } as never);
    await expect(
      nf.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const conflict = new SalesController({
      recordVoid: jest.fn().mockRejectedValue(new TerminalEventProvenanceConflictError()),
    } as never);
    await expect(
      conflict.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, makeRes() as never),
    ).rejects.toBeInstanceOf(ConflictException);

    const boom = new SalesController({
      recordVoid: jest.fn().mockRejectedValue(new Error("kaboom")),
    } as never);
    await expect(
      boom.recordVoid({ context: ctx } as never, VALID_REF, voidBody as never, makeRes() as never),
    ).rejects.toThrow(/kaboom/);
  });
});
