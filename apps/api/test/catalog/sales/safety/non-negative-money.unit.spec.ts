/**
 * non-negative-money.unit.spec.ts — B1-3 (POS backend adversarial review).
 *
 * Docker-free unit coverage proving the capture DTO rejects NEGATIVE monetary
 * amounts at the boundary, matching the DB CHECK constraints in
 * `0012_sales.sql` (`sales_pos_total_non_negative`,
 * `sale_lines_unit_price_non_negative`, `sale_lines_line_amount_non_negative`,
 * `sale_lines_quantity_non_negative`, `sale_lines_tax_amount_non_negative`).
 *
 * Before this fix the capture DTO used the SIGNED `DecimalAmount`
 * (`/^-?[0-9]{1,15}.../`), so a negative posTotal / unitPrice / lineAmount /
 * taxAmount passed `.strict()` Zod validation, reached the INSERT, and 500'd on
 * the CHECK violation. The contract must reject negatives at the boundary (the
 * same posture `RecordRefundRequestSchema` already takes for `posRefundAmount`).
 */
import { CaptureSaleRequestSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";

/** A minimal valid capture body; individual tests override one field. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "sale-001",
    currencyCode: "EGP",
    posTotal: "12.50",
    occurredAt: "2026-06-21T10:00:00.000Z",
    lines: [
      {
        lineName: "Paracetamol 500mg",
        unitPrice: "12.50",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "12.50",
        unit: "box",
      },
    ],
    ...overrides,
  };
}

describe("B1-3 — captureSale rejects negative monetary amounts", () => {
  it("accepts a fully non-negative body (baseline)", () => {
    expect(CaptureSaleRequestSchema.safeParse(validBody()).success).toBe(true);
  });

  it("rejects a negative posTotal", () => {
    const result = CaptureSaleRequestSchema.safeParse(validBody({ posTotal: "-12.50" }));
    expect(result.success).toBe(false);
  });

  it("rejects a negative line unitPrice", () => {
    const result = CaptureSaleRequestSchema.safeParse(
      validBody({
        lines: [
          {
            lineName: "x",
            unitPrice: "-1.00",
            currencyCode: "EGP",
            quantity: "1",
            lineAmount: "1.00",
            unit: "box",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative line lineAmount", () => {
    const result = CaptureSaleRequestSchema.safeParse(
      validBody({
        lines: [
          {
            lineName: "x",
            unitPrice: "1.00",
            currencyCode: "EGP",
            quantity: "1",
            lineAmount: "-1.00",
            unit: "box",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative line taxAmount", () => {
    const result = CaptureSaleRequestSchema.safeParse(
      validBody({
        lines: [
          {
            lineName: "x",
            unitPrice: "1.00",
            currencyCode: "EGP",
            quantity: "1",
            lineAmount: "1.00",
            taxAmount: "-0.50",
            unit: "box",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("still accepts a zero amount (>= 0, not > 0)", () => {
    const result = CaptureSaleRequestSchema.safeParse(
      validBody({
        posTotal: "0",
        lines: [
          {
            lineName: "free sample",
            unitPrice: "0",
            currencyCode: "EGP",
            quantity: "1",
            lineAmount: "0",
            unit: "box",
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});
