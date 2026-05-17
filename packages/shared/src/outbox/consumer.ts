/**
 * T582 — OutboxConsumer interface (consumer contract).
 *
 * Every consumer that the drainer can dispatch to MUST implement this
 * interface. The drainer resolves the concrete implementation from a
 * registry keyed on `eventType`.
 *
 * Idempotency obligation
 * ----------------------
 * The outbox provides at-least-once delivery. Consumers MUST tolerate
 * re-delivery of the same `event_id`. In Slice 1B, idempotency is
 * enforced at the outbox row level: a `delivered` row cannot be
 * re-claimed by the drainer (the claim query filters only
 * `delivery_state IN ('pending', 'failed')`). The per-consumer
 * `(consumer_id, event_id)` dedup projection (`processed_events` table)
 * is deferred to Slice 1C (requires a new migration — T564 / T565).
 *
 * Tenant context obligation
 * -------------------------
 * Any DB access beyond reading/updating the outbox row itself MUST be
 * wrapped in `runWithTenantContext` with the event's `tenant_id`.
 * Skipping this will fail RLS — T561 proves this regression.
 *
 * Field types align with the Slice 1A `outbox_events` schema:
 *   event_id      → uuid (string at runtime)
 *   event_type    → text
 *   tenant_id     → uuid (NOT NULL in the schema)
 *   store_id      → uuid NULLABLE
 *   payload       → jsonb (typed as TPayload by the implementer)
 *   correlation_id → uuid NULLABLE
 *   attempts      → int (already incremented at claim time)
 *   occurred_at   → timestamptz → Date at runtime
 */

/**
 * The event envelope passed by the drainer to every consumer's
 * `handle()` method. Fields are a strict subset of the `outbox_events`
 * row — only the fields a consumer needs to perform its side-effect.
 */
export interface OutboxEventEnvelope<TPayload = unknown> {
  /** Primary key; also the consumer dedup key (per lifecycle.md §5). */
  readonly event_id: string;
  /** Registry-controlled event type name (e.g. `audit.event.created`). */
  readonly event_type: string;
  /** Tenant that produced the event. NOT NULL. */
  readonly tenant_id: string;
  /** Store scope, or null for tenant-level events. */
  readonly store_id: string | null;
  /** Decoded JSONB payload. Type is consumer-defined. */
  readonly payload: TPayload;
  /** End-to-end correlation id from the originating request or job. */
  readonly correlation_id: string | null;
  /**
   * Number of attempts already made, INCLUDING the current one.
   * Incremented at claim time (inside the claim CTE) before this
   * method is invoked.
   */
  readonly attempts: number;
  /** Business event timestamp (UTC). */
  readonly occurred_at: Date;
}

/**
 * Contract every outbox consumer must satisfy.
 *
 * @typeParam TPayload — the event-type-specific payload shape. Consumers
 *   are encouraged to narrow this to a Zod-inferred type.
 */
export interface OutboxConsumer<TPayload = unknown> {
  /**
   * Stable identifier for this consumer. Used by the drainer registry and
   * will be the primary key in the `processed_events` dedup table (Slice 1C).
   * MUST be unique per consumer in the registry.
   *
   * Convention: `<domain>.<event_type>` (e.g. `worker.audit.event.created`).
   */
  readonly consumerId: string;

  /**
   * The event type this consumer handles. The drainer registry maps this
   * to the concrete consumer instance.
   */
  readonly eventType: string;

  /**
   * Perform the consumer's side-effect for the given event.
   *
   * - MUST be idempotent (at-least-once delivery guarantee).
   * - MUST establish tenant context via `runWithTenantContext` before any
   *   DB access beyond the outbox row itself.
   * - On success: return normally; the drainer marks the row `delivered`.
   * - On transient failure: throw; the drainer transitions to `failed` and
   *   schedules a retry per the backoff schedule.
   * - On permanent failure (poison event): throw consistently until the
   *   8-attempt budget is exhausted; the drainer transitions to `dead_lettered`.
   */
  handle(event: OutboxEventEnvelope<TPayload>): Promise<void>;
}
