/**
 * Receivable projection + `toReceivable` (035 T030).
 *
 * The wire shape every receivable-returning route emits, mirroring the OpenAPI
 * `Receivable` schema (packages/contracts/openapi/settlement/settlement.yaml):
 *   required: [receivableRef, saleRef, payerRef, outstandingBalance, state, version]
 *   additionalProperties: false
 *
 * Carries NO `tenant_id` (implicit in scope, §IV), no raw sale lines, no
 * `payload_hash`. Money is an exact-decimal STRING (§III) — pg returns
 * `numeric(19,4)` as a string on read, so no float ever touches the value.
 * `state` is the non-reversal lifecycle (no `reversal_consumed`, §OQ-4 CARVE).
 */
import type { ReceivableState } from "../receivable-state-machine";

/** The service row shape (camelCase) the projection consumes. */
export interface ReceivableRow {
  readonly id: string;
  readonly saleId: string;
  readonly payerId: string;
  readonly outstandingBalance: string;
  readonly state: ReceivableState;
  readonly erpnextPaymentEntryRef: string | null;
  readonly taxPlaceholder: Record<string, unknown> | null;
  readonly version: number;
}

/** The wire body (camelCase per the YAML; §IV strict projection). */
export interface ReceivableBody {
  readonly receivableRef: string;
  readonly saleRef: string;
  readonly payerRef: string;
  readonly outstandingBalance: string;
  readonly state: ReceivableState;
  readonly erpnextPaymentEntryRef: string | null;
  readonly taxPlaceholder: Record<string, unknown> | null;
  readonly version: number;
}

/** Project a service row to the §IV wire body. */
export function toReceivable(row: ReceivableRow): ReceivableBody {
  return {
    receivableRef: row.id,
    saleRef: row.saleId,
    payerRef: row.payerId,
    outstandingBalance: row.outstandingBalance,
    state: row.state,
    erpnextPaymentEntryRef: row.erpnextPaymentEntryRef,
    taxPlaceholder: row.taxPlaceholder,
    version: row.version,
  };
}
