/**
 * dto.spec.ts — 035 T030 (pure unit, no DB).
 *
 * Pins the strict request DTOs (§XII mass-assignment ban) + the `toReceivable`
 * §IV projection against the contract field names.
 */
import "reflect-metadata";

import { toReceivable, type ReceivableRow } from "../../../src/settlement/dto/receivable.dto";
import { ReceivableListQuerySchema } from "../../../src/settlement/dto/receivable-query.dto";
import { SettlementIntentCreateSchema } from "../../../src/settlement/dto/settlement-intent-request.dto";

const SALE = "0a000000-0000-7000-8000-00000000a501";
const PAYER = "0a000000-0000-7000-8000-00000000a5e1";

describe("SettlementIntentCreate DTO", () => {
  it("accepts a single-payer intent", () => {
    const parsed = SettlementIntentCreateSchema.parse({
      saleRef: SALE,
      payers: [{ payerRef: PAYER, owedAmount: "120.00" }],
    });
    expect(parsed.payers).toHaveLength(1);
    expect(parsed.payers[0]!.owedAmount).toBe("120.00");
  });

  it("accepts a split (multi-payer) intent + optional cashTendered/claimMetadata", () => {
    const parsed = SettlementIntentCreateSchema.parse({
      saleRef: SALE,
      cashTendered: "10.00",
      payers: [
        { payerRef: PAYER, owedAmount: "50.0000", claimMetadata: { policy: "P-1" } },
        { payerRef: "0a000000-0000-7000-8000-00000000a5e2", owedAmount: "60" },
      ],
    });
    expect(parsed.payers).toHaveLength(2);
  });

  it("rejects an empty / oversized payer list", () => {
    expect(() => SettlementIntentCreateSchema.parse({ saleRef: SALE, payers: [] })).toThrow();
    const many = Array.from({ length: 17 }, () => ({ payerRef: PAYER, owedAmount: "1.00" }));
    expect(() => SettlementIntentCreateSchema.parse({ saleRef: SALE, payers: many })).toThrow();
  });

  it("rejects non-positive / over-precision / malformed money", () => {
    for (const bad of ["0", "0.00", "-5.00", "1.23456", "abc", "1,000.00", "1e3"]) {
      expect(() =>
        SettlementIntentCreateSchema.parse({
          saleRef: SALE,
          payers: [{ payerRef: PAYER, owedAmount: bad }],
        }),
      ).toThrow();
    }
  });

  it("rejects a smuggled server-resolved key (mass-assignment ban, §XII)", () => {
    for (const extra of [{ tenantId: "x" }, { storeId: "x" }, { actorUserId: "x" }]) {
      expect(() =>
        SettlementIntentCreateSchema.parse({
          saleRef: SALE,
          payers: [{ payerRef: PAYER, owedAmount: "1.00" }],
          ...extra,
        }),
      ).toThrow();
    }
  });

  it("rejects a smuggled key inside a payer entry", () => {
    expect(() =>
      SettlementIntentCreateSchema.parse({
        saleRef: SALE,
        payers: [{ payerRef: PAYER, owedAmount: "1.00", tenantId: "x" }],
      }),
    ).toThrow();
  });

  it("rejects a non-uuid saleRef / payerRef", () => {
    expect(() =>
      SettlementIntentCreateSchema.parse({ saleRef: "not-a-uuid", payers: [{ payerRef: PAYER, owedAmount: "1.00" }] }),
    ).toThrow();
    expect(() =>
      SettlementIntentCreateSchema.parse({ saleRef: SALE, payers: [{ payerRef: "nope", owedAmount: "1.00" }] }),
    ).toThrow();
  });
});

describe("ReceivableListQuery DTO", () => {
  it("accepts an empty query (all optional)", () => {
    expect(ReceivableListQuerySchema.parse({})).toEqual({});
  });

  it("coerces page_size and accepts valid filters + cursor", () => {
    const parsed = ReceivableListQuerySchema.parse({
      store_id: SALE,
      state: "open",
      payer_ref: PAYER,
      cursor: "0a000000-0000-4000-8000-00000000a5c1",
      page_size: "25",
    });
    expect(parsed.page_size).toBe(25);
    expect(parsed.state).toBe("open");
  });

  it("rejects an out-of-range page_size and an invalid state", () => {
    expect(() => ReceivableListQuerySchema.parse({ page_size: "0" })).toThrow();
    expect(() => ReceivableListQuerySchema.parse({ page_size: "201" })).toThrow();
    expect(() => ReceivableListQuerySchema.parse({ state: "reversal_consumed" })).toThrow();
  });

  it("rejects a malformed cursor and an unknown query key (strict)", () => {
    expect(() => ReceivableListQuerySchema.parse({ cursor: "not-a-uuid" })).toThrow();
    expect(() => ReceivableListQuerySchema.parse({ tenant_id: SALE })).toThrow();
  });
});

describe("toReceivable projection (§IV)", () => {
  it("maps the row to the contract wire shape (camelCase, no tenant_id)", () => {
    const row: ReceivableRow = {
      id: "0a000000-0000-4000-8000-00000000a5d1",
      saleId: SALE,
      payerId: PAYER,
      outstandingBalance: "120.0000",
      state: "open",
      erpnextPaymentEntryRef: null,
      taxPlaceholder: null,
      version: 0,
    };
    const body = toReceivable(row);
    expect(body).toEqual({
      receivableRef: row.id,
      saleRef: SALE,
      payerRef: PAYER,
      outstandingBalance: "120.0000",
      state: "open",
      erpnextPaymentEntryRef: null,
      taxPlaceholder: null,
      version: 0,
    });
    expect(body).not.toHaveProperty("tenant_id");
    expect(body).not.toHaveProperty("tenantId");
  });
});
