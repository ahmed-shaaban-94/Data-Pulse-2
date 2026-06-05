/**
 * 015 — `erpnext.posting.requested` outbox consumer.
 *
 * Reads an `erpnext.posting.requested` outbox event (emitted in-transaction by
 * the 008 `SaleProcessingProcessor` when a sale becomes processed) and, at this
 * CREATION moment, resolves posting ELIGIBILITY (015-RESOLVE) and inserts the
 * `erpnext_posting_status` row:
 *   - every line resolves to a CONFIRMED erpnext_item_map AND the store maps to
 *     an erpnext_warehouse_map → `pending` (the connector feed will offer it);
 *   - otherwise → `permanently_rejected` with the nearest 012 category
 *     (`unmapped_item` / `unmapped_store`), BEFORE the work-item is ever offered
 *     (rider R2 "fails-to-DLQ before offered"). The 008 sale fact is NEVER
 *     mutated; the failure is a reconciliation case (017), never routed to the
 *     inbound unknown-items queue (rider R4).
 *
 * DEVIATION from SaleCaptured/AuditEventCreated (which bridge to a BullMQ queue):
 * this consumer does the resolve+insert DB work DIRECTLY. There is no
 * pre-existing downstream processor to hand off to, and the outbox layer already
 * gives at-least-once + retry-budget + dead-letter — a second BullMQ hop would be
 * redundant retry, not added safety. The consumer takes a `Pool` and establishes
 * its own tenant context via `runWithTenantContext` (the OutboxConsumer contract
 * mandates this for DB access).
 *
 * Idempotency (at-least-once): if the drainer crashes after the insert but before
 * marking the row delivered, `handle()` re-runs. The INSERT is
 * `ON CONFLICT (tenant_id, source_ref_id) DO NOTHING` (the O-3 unique), so a
 * re-delivery is a no-op and the FIRST verdict stands — never a throw-then-
 * dead-letter loop.
 *
 * Payload shape: IDs + provenance only (sale_id / store_id / kind / source_ref_id)
 * — NO money / PII. The ENVELOPE tenant_id is authoritative (a tampered payload
 * tenant must not redirect the write).
 */
import { z } from "zod";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId, type OutboxConsumer, type OutboxEventEnvelope } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Payload schema — IDs + provenance only (no PII / money)
// ---------------------------------------------------------------------------

const PostingRequestedPayloadSchema = z.object({
  sale_id: z.string().uuid(),
  store_id: z.string().uuid(),
  kind: z.enum(["sale_post", "reversal"]),
  source_ref_id: z.string().uuid(),
});

export type PostingRequestedPayload = z.infer<
  typeof PostingRequestedPayloadSchema
>;

export const POSTING_REQUESTED_CONSUMER_ID = "worker.erpnext.posting.requested";

type RejectionCategory = "unmapped_item" | "unmapped_store";

export class PostingRequestedConsumer
  implements OutboxConsumer<PostingRequestedPayload>
{
  readonly consumerId = POSTING_REQUESTED_CONSUMER_ID;
  readonly eventType = "erpnext.posting.requested";

  constructor(private readonly pool: Pool) {}

  async handle(
    event: OutboxEventEnvelope<PostingRequestedPayload>,
  ): Promise<void> {
    const parsed = PostingRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join(".") || "<root>"}: ${first.message}`
        : "validation failed";
      throw new Error(
        `PostingRequestedConsumer: malformed payload — ${detail}`,
      );
    }
    const { sale_id, store_id, kind, source_ref_id } = parsed.data;
    // The ENVELOPE tenant is authoritative (not the payload).
    const tenantId = event.tenant_id;

    await runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const verdict = await this.resolveEligibility(client, {
          saleId: sale_id,
          storeId: store_id,
        });

        // Conflict-safe insert (O-3 unique on (tenant_id, source_ref_id)): a
        // re-delivery is a no-op; the first verdict stands.
        await client.query(
          `INSERT INTO erpnext_posting_status
             (id, tenant_id, store_id, sale_id, kind, source_ref_id,
              source_system, external_id, payload_hash, status,
              rejection_category, correlation_id)
           SELECT $1, $2, $3, $4, $5, $6,
                  s.source_system, s.external_id, s.payload_hash, $7, $8, $9
             FROM sales s
            WHERE s.id = $4 AND s.store_id = $3
           ON CONFLICT (tenant_id, source_ref_id) DO NOTHING`,
          [
            newId(),
            tenantId,
            store_id,
            sale_id,
            kind,
            source_ref_id,
            verdict.status,
            verdict.status === "permanently_rejected"
              ? verdict.rejectionCategory
              : null,
            event.correlation_id,
          ],
        );
      },
    );
  }

  /**
   * 015-RESOLVE at creation time. Read-only; the caller persists the verdict.
   * Mirrors the api-side `posting-work-item.projection.ts` resolution (kept in
   * SQL so the worker need not import api code).
   */
  private async resolveEligibility(
    client: PoolClient,
    input: { saleId: string; storeId: string },
  ): Promise<
    | { status: "pending" }
    | { status: "permanently_rejected"; rejectionCategory: RejectionCategory }
  > {
    // (a) store → an active warehouse mapping (rider R5: never guess).
    const wh = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM erpnext_warehouse_map
        WHERE store_id = $1 AND retired_at IS NULL`,
      [input.storeId],
    );
    if (Number(wh.rows[0]?.count ?? "0") === 0) {
      return { status: "permanently_rejected", rejectionCategory: "unmapped_store" };
    }

    // (b) every line → a CONFIRMED, non-retired item map; a null tenant_product_ref
    // (ad-hoc, FR-004) or only a `suggested` map counts as unmapped (R3).
    const unmapped = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sale_lines sl
         LEFT JOIN erpnext_item_map m
           ON m.tenant_product_id = sl.tenant_product_ref
          AND m.state = 'confirmed'
          AND m.retired_at IS NULL
        WHERE sl.sale_id = $1
          AND (sl.tenant_product_ref IS NULL OR m.id IS NULL)`,
      [input.saleId],
    );
    if (Number(unmapped.rows[0]?.count ?? "0") > 0) {
      return { status: "permanently_rejected", rejectionCategory: "unmapped_item" };
    }

    return { status: "pending" };
  }
}
