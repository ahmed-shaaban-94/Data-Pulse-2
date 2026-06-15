/**
 * ClaimService — 035 T032.
 *
 * Claim submission + remittance reconciliation (FR-014), the Console third-party
 * collection surface. Mirrors ReceivableService: one `runWithTenantContext` tx
 * per op, discriminated-union results (service never throws HttpException), the
 * controller maps to HTTP.
 *
 * submitClaim: validates the payer + every receivable is in-scope AND claimable
 * (open | partially_applied), creates `claim` + `claim_receivables`, transitions
 * the receivables → 'claimed'. All-or-nothing.
 *
 * reconcileRemittance: the claim must be reconcilable (status submitted |
 * acknowledged — NOT already reconciled). The claimed amount is the SUM of the
 * claimed receivables' current outstanding balances. The pure `decideReconciliation`
 * computes variance + outcome; we record a `remittance` + `reconciliation_result`,
 * settle (outcome settled) / flag (outcome flagged) the receivables, and mark the
 * claim 'reconciled'. Rejection of a line is NOT modelled here — it routes to
 * DP-026 + Connector Arc A + POS-014 (FR-015, NG-1). Idempotency is the HTTP
 * interceptor's job.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../auth/auth.module";
import { decideReconciliation } from "./reconcile-decision";
import type {
  ClaimBody,
  ReconciliationResultBody,
} from "./dto/claim-request.dto";

export interface SubmitClaimInput {
  readonly tenantId: string;
  readonly payerRef: string;
  readonly receivableRefs: readonly string[];
}

export type SubmitClaimResult =
  | { kind: "ok"; claim: ClaimBody }
  | { kind: "not_found" }
  | { kind: "conflict" };

export interface ReconcileInput {
  readonly tenantId: string;
  readonly claimRef: string;
  readonly remittedAmount: string;
  readonly remittanceRef?: string | null;
}

export type ReconcileResult =
  | { kind: "ok"; result: ReconciliationResultBody }
  | { kind: "not_found" }
  | { kind: "conflict" };

const CLAIMABLE_STATES = ["open", "partially_applied"];

@Injectable()
export class ClaimService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async submitClaim(input: SubmitClaimInput): Promise<SubmitClaimResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<SubmitClaimResult> => {
        // Payer must resolve in tenant (RLS-filtered) → else non-disclosing 404.
        const payer = await client.query<{ store_id: string | null }>(
          `SELECT store_id FROM payer_account WHERE id = $1::uuid LIMIT 1`,
          [input.payerRef],
        );
        if (!payer.rows[0]) return { kind: "not_found" };

        // Lock + validate every receivable: in-scope, claimable state. A missing
        // one (RLS / fabricated) or a non-claimable one is a deterministic
        // conflict (the batch is all-or-nothing; no partial claim).
        const refs = [...new Set(input.receivableRefs)];
        const found = await client.query<{
          id: string;
          state: string;
          store_id: string;
        }>(
          `SELECT id, state, store_id FROM receivable
            WHERE id = ANY($1::uuid[]) FOR UPDATE`,
          [refs],
        );
        if (found.rows.length !== refs.length) return { kind: "conflict" };
        if (found.rows.some((r) => !CLAIMABLE_STATES.includes(r.state))) {
          return { kind: "conflict" };
        }
        // The claim is store-scoped to the receivables' store (they must agree).
        const storeIds = new Set(found.rows.map((r) => r.store_id));
        if (storeIds.size !== 1) return { kind: "conflict" };
        const storeId = [...storeIds][0]!;

        // Create the claim + join rows; transition the receivables → 'claimed'.
        const claimId = newId();
        await client.query(
          `INSERT INTO claim (id, tenant_id, store_id, payer_id, status, version)
           VALUES ($1, $2, $3, $4, 'submitted', 0)`,
          [claimId, input.tenantId, storeId, input.payerRef],
        );
        for (const ref of refs) {
          await client.query(
            `INSERT INTO claim_receivables
               (id, tenant_id, store_id, claim_id, receivable_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [newId(), input.tenantId, storeId, claimId, ref],
          );
        }
        await client.query(
          `UPDATE receivable SET state = 'claimed', version = version + 1,
                  updated_at = now()
            WHERE id = ANY($1::uuid[])`,
          [refs],
        );

        return {
          kind: "ok",
          claim: {
            claimRef: claimId,
            payerRef: input.payerRef,
            status: "submitted",
            receivableRefs: refs,
          },
        };
      },
    );
  }

  async reconcileRemittance(input: ReconcileInput): Promise<ReconcileResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReconcileResult> => {
        const claim = await client.query<{ status: string; store_id: string }>(
          `SELECT status, store_id FROM claim WHERE id = $1::uuid FOR UPDATE`,
          [input.claimRef],
        );
        const c = claim.rows[0];
        if (!c) return { kind: "not_found" };
        // Reconcilable only while submitted | acknowledged (not already reconciled).
        if (c.status === "reconciled") return { kind: "conflict" };

        const claimed = await this.sumClaimedBalances(client, input.claimRef);
        const decision = decideReconciliation({
          claimedAmount: claimed,
          remittedAmount: input.remittedAmount,
        });

        // Record the remittance + the reconciliation result.
        await client.query(
          `INSERT INTO remittance
             (id, tenant_id, store_id, claim_id, remitted_amount, remittance_ref)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            newId(),
            input.tenantId,
            c.store_id,
            input.claimRef,
            input.remittedAmount,
            input.remittanceRef ?? null,
          ],
        );
        await client.query(
          `INSERT INTO reconciliation_result
             (id, tenant_id, store_id, claim_id, claimed_amount,
              remitted_amount, variance, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newId(),
            input.tenantId,
            c.store_id,
            input.claimRef,
            claimed,
            input.remittedAmount,
            decision.variance,
            decision.outcome,
          ],
        );

        // Advance the claimed receivables: settled → settled (balance 0);
        // flagged → flagged; partial leaves them 'claimed' (still owed). Then the
        // claim itself is 'reconciled'.
        if (decision.outcome === "settled") {
          await client.query(
            `UPDATE receivable SET state = 'settled', outstanding_balance = 0,
                    version = version + 1, updated_at = now()
              WHERE id IN (SELECT receivable_id FROM claim_receivables
                            WHERE claim_id = $1::uuid)`,
            [input.claimRef],
          );
        } else if (decision.outcome === "flagged") {
          await client.query(
            `UPDATE receivable SET state = 'flagged', version = version + 1,
                    updated_at = now()
              WHERE id IN (SELECT receivable_id FROM claim_receivables
                            WHERE claim_id = $1::uuid)`,
            [input.claimRef],
          );
        }
        await client.query(
          `UPDATE claim SET status = 'reconciled', version = version + 1,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [input.claimRef],
        );

        return {
          kind: "ok",
          result: {
            claimRef: input.claimRef,
            claimedAmount: claimed,
            remittedAmount: input.remittedAmount,
            variance: decision.variance,
            outcome: decision.outcome,
          },
        };
      },
    );
  }

  /** SUM of the claim's receivables' current outstanding balances (scale-4 string). */
  private async sumClaimedBalances(
    client: PoolClient,
    claimRef: string,
  ): Promise<string> {
    const r = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(r.outstanding_balance), 0)::numeric(19,4)::text AS total
         FROM claim_receivables cr
         JOIN receivable r ON r.id = cr.receivable_id
        WHERE cr.claim_id = $1::uuid`,
      [claimRef],
    );
    return r.rows[0]?.total ?? "0.0000";
  }
}
