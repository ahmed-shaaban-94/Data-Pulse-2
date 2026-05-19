/**
 * admin.dto.ts — wire shapes for the outbox dead-letter admin endpoints.
 *
 * Mirrors `packages/contracts/openapi/outbox.openapi.yaml` (slice 1C-C1).
 *
 *   OutboxDeadLetter:
 *     { event_id, event_type, tenant_id, store_id, delivery_state,
 *       attempts, correlation_id, last_error_class, occurred_at,
 *       created_at, updated_at, processed_at }
 *
 *   ListOutboxDeadLettersResponse:
 *     { items: OutboxDeadLetter[], next_cursor: string | null }
 *
 * Snake_case field names match the OpenAPI YAML — the controller hands
 * this back verbatim, no further mapping. Timestamps are ISO 8601 strings
 * (not `Date`) so JSON serialization is stable.
 *
 * `delivery_state` is hard-pinned to the literal `"dead_lettered"` — the
 * endpoint contract is dead-letter triage; any other state surfaces as 404.
 * The OpenAPI schema mirrors this with `enum: [dead_lettered]`.
 *
 * NEVER includes `payload`. NEVER includes `last_error` (the column is
 * already class-only; the field name `last_error_class` makes the contract
 * explicit and the repository's `sanitizeLastErrorClass` re-validates as
 * defence-in-depth).
 */

/** Single dead-letter row as returned by both list and detail endpoints. */
export interface OutboxDeadLetterDto {
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string;
  readonly store_id: string | null;
  readonly delivery_state: "dead_lettered";
  readonly attempts: number;
  readonly correlation_id: string | null;
  readonly last_error_class: string | null;
  readonly occurred_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly processed_at: string | null;
}

/** List endpoint envelope — matches the audit endpoint shape exactly. */
export interface ListOutboxDeadLettersResponse {
  readonly items: readonly OutboxDeadLetterDto[];
  readonly next_cursor: string | null;
}
