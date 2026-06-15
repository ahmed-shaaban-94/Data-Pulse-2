/**
 * apply-payment-request.dto.ts — 035 T031.
 *
 * Strict Zod schema for the `consoleApplyPayment` body
 * (contract `PaymentApplicationCreate`): { amount, version, note? }.
 * `additionalProperties:false` ⇒ `.strict()` (smuggled fields → 400). The path
 * `receivableRef` is validated separately by the controller. `tenant_id` /
 * `store_id` / actor are server-resolved, never in the body (§XII).
 */
import { z } from "zod";

/** Exact-decimal money string (no floats, §III) — up to 4 fractional digits. */
const MoneyString = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "amount must be an exact-decimal money string");

export const ApplyPaymentRequestSchema = z
  .object({
    amount: MoneyString,
    version: z.number().int().min(0),
    note: z.string().max(500).nullish(),
  })
  .strict();

export type ApplyPaymentRequestDto = z.infer<typeof ApplyPaymentRequestSchema>;
