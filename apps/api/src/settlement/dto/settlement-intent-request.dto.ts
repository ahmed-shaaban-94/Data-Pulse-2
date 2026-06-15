/**
 * SettlementIntentCreate DTO + Zod schema (035 T030).
 *
 * Mirrors the OpenAPI `SettlementIntentCreate` + `SettlementIntentPayer`
 * (packages/contracts/openapi/settlement/settlement.yaml):
 *   SettlementIntentCreate: required [saleRef, payers], additionalProperties:false
 *   SettlementIntentPayer:  required [payerRef, owedAmount], additionalProperties:false
 *
 * STRICT (`.strict()`) — §XII mass-assignment ban: `tenant_id`, `store_id`, and
 * the actor are server-resolved from the operator envelope (request.context),
 * never the body; a smuggled key is rejected 400 `validation_error`.
 *
 * Money is an exact-decimal STRING (§III). `Money` here validates the wire
 * shape only — the authoritative numeric lives in `numeric(19,4)` and the
 * string is inserted directly (no JS float math). A non-positive owed amount is
 * rejected at the boundary (a receivable for 0 / negative is meaningless and
 * the 0027 `receivable_balance_non_negative` CHECK would reject negatives).
 */
import { z } from "zod";

/**
 * Exact-decimal money string: a non-negative decimal with up to 4 fractional
 * digits (the column scale). No sign, no exponent, no thousands separators.
 * E.g. "120.00", "0.5", "99999999999999.9999".
 */
const MONEY_RE = /^\d{1,15}(\.\d{1,4})?$/;

const OwedAmountSchema = z
  .string()
  .regex(MONEY_RE, "owedAmount must be an exact-decimal money string (<=4 dp)")
  .refine((v) => Number(v) > 0, "owedAmount must be greater than zero");

export const SettlementIntentPayerSchema = z
  .object({
    payerRef: z.string().uuid(),
    owedAmount: OwedAmountSchema,
    // Optional opaque payer claim metadata (e.g. policy ref); not interpreted.
    claimMetadata: z.record(z.unknown()).nullish(),
  })
  .strict();

export const SettlementIntentCreateSchema = z
  .object({
    saleRef: z.string().uuid(),
    // The cash portion settled at the till (sale metadata, NOT authoritative for
    // the receivable amount — owedAmount is). Validated as money-or-null; never
    // used for arithmetic in this slice.
    cashTendered: z
      .string()
      .regex(MONEY_RE, "cashTendered must be an exact-decimal money string")
      .nullish(),
    payers: z.array(SettlementIntentPayerSchema).min(1).max(16),
  })
  .strict();

export type SettlementIntentPayerDto = z.infer<typeof SettlementIntentPayerSchema>;
export type SettlementIntentCreateDto = z.infer<typeof SettlementIntentCreateSchema>;
