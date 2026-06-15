/**
 * claim-request.dto.ts — 035 T032.
 *
 * Strict Zod schemas for the claim/remittance write bodies (contract
 * `ClaimCreate` + `RemittanceReconcile`). `additionalProperties:false` ⇒
 * `.strict()`. tenant/store/actor are server-resolved, never in the body (§XII).
 */
import { z } from "zod";

const MoneyString = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "amount must be an exact-decimal money string");

export const ClaimCreateSchema = z
  .object({
    payerRef: z.string().uuid(),
    receivableRefs: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();

export type ClaimCreateDto = z.infer<typeof ClaimCreateSchema>;

export const RemittanceReconcileSchema = z
  .object({
    remittedAmount: MoneyString,
    remittanceRef: z.string().max(255).nullish(),
  })
  .strict();

export type RemittanceReconcileDto = z.infer<typeof RemittanceReconcileSchema>;

/** Wire projection of a claim (contract `Claim`). */
export interface ClaimBody {
  readonly claimRef: string;
  readonly payerRef: string;
  readonly status: "submitted" | "acknowledged" | "reconciled";
  readonly receivableRefs: string[];
}

/** Wire projection of a reconciliation result (contract `ReconciliationResult`). */
export interface ReconciliationResultBody {
  readonly claimRef: string;
  readonly claimedAmount: string;
  readonly remittedAmount: string;
  readonly variance: string;
  readonly outcome: "settled" | "partial" | "flagged";
}
