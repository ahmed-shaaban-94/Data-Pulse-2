/**
 * capture-sale-request.dto.ts — 008 US1 (T035).
 *
 * Strict Zod schema for the `captureSale` request body, mirroring the
 * `CaptureSaleRequest` schema in
 * `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * `.strict()` enforces the FR-061/062 mass-assignment ban at the boundary:
 * tenant_id / store_id / created_by / received_at / business_date /
 * processed_at / mismatch_flag are NOT accepted from the body — they resolve
 * server-side. Any unknown key → deterministic validation failure.
 *
 * Money + quantity are exact-decimal STRINGS (gate A.6 — no float ever): the
 * service round-trips them to Postgres `numeric` and never parses them into a
 * JS number.
 */
import { z } from "zod";

/** Exact-decimal money string: up to 15 integer + 4 fractional digits. */
const decimalAmount = z
  .string()
  .regex(/^-?[0-9]{1,15}(\.[0-9]{1,4})?$/, "must be an exact-decimal string");

/** Line quantity: up to 6 fractional digits (sub-unit quantities allowed). */
const quantityAmount = z
  .string()
  .regex(/^[0-9]{1,15}(\.[0-9]{1,6})?$/, "must be a non-negative decimal string");

/** ISO-4217 alphabetic currency code. */
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "must be an ISO-4217 code");

export const CaptureSaleLineSchema = z
  .object({
    lineName: z.string().min(1).max(500),
    unitPrice: decimalAmount,
    currencyCode,
    quantity: quantityAmount,
    lineAmount: decimalAmount,
    taxAmount: decimalAmount.optional(),
    unit: z.string().min(1).max(50),
    tenantProductRef: z.string().uuid().optional(),
  })
  .strict();

export const CaptureSaleRequestSchema = z
  .object({
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    currencyCode,
    posTotal: decimalAmount,
    occurredAt: z.string().datetime(),
    sourceClockAt: z.string().datetime().optional(),
    lines: z.array(CaptureSaleLineSchema).min(1),
  })
  .strict();

export type CaptureSaleRequestDto = z.infer<typeof CaptureSaleRequestSchema>;
export type CaptureSaleLineDto = z.infer<typeof CaptureSaleLineSchema>;
