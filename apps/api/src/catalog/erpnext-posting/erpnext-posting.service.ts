/**
 * ErpnextPostingService — 015-US1-FEED (T031).
 *
 * The DP2-side read of the fixed 012 posting-feed contract:
 *   - `pullPostings()` — a PURE READ of `pending` `erpnext_posting_status` rows
 *     for the connector principal's tenant, cursor-ordered by the row `sequence`,
 *     each projected into a 012 `PostingWorkItem` (lines carry the DP2-resolved
 *     `erpnextItemRef`). NO status mutation → re-pulling the same `since` cursor
 *     yields the same logical set (012 idempotent replay).
 *
 * The COMPLEMENTARY write — resolving eligibility and inserting the `pending` /
 * `permanently_rejected` row — happens at row CREATION in the worker-side
 * `erpnext.posting.requested` consumer (NOT here, NOT at pull). See
 * `posting-work-item.projection.ts` for the two-moment split.
 *
 * All queries run under the caller's tenant GUC via `runWithTenantContext`
 * (tenant from the connector principal, never the body — §XII); RLS scopes rows.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { runWithTenantContext } from "@data-pulse-2/db";
import {
  buildWorkItem,
  type PostingWorkItem,
} from "./posting-work-item.projection";

/**
 * Hard ceiling on a single pull page — the 012 contract `Limit.maximum` (500),
 * aligning with the 009 backfill ceiling. The contract `default` is 100; the
 * controller applies that default, this caps the upper bound.
 */
export const POSTING_FEED_MAX_PAGE = 500;

export interface PullPostingsInput {
  readonly tenantId: string;
  /** Opaque cursor — the last `sequence` the connector saw. null = from start. */
  readonly since: bigint | null;
  readonly limit: number;
}

export interface PullPostingsResult {
  readonly items: readonly PostingWorkItem[];
  /** The advanced opaque cursor (the last item's sequence), as a string. */
  readonly cursor: string | null;
  /** Next-page token (the same advanced cursor) when the page was full. */
  readonly nextPageToken: string | null;
}

@Injectable()
export class ErpnextPostingService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Pull a cursor-ordered page of pending posting work-items. Read-only; orders
   * by the monotonic `sequence` (> `since`); caps at `POSTING_FEED_MAX_PAGE`.
   */
  async pullPostings(input: PullPostingsInput): Promise<PullPostingsResult> {
    const limit = Math.min(Math.max(1, input.limit), POSTING_FEED_MAX_PAGE);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Pending rows only, after the `since` cursor, ordered + capped. RLS
        // scopes to the connector principal's tenant; the partial index
        // idx_erpnext_posting_status_pending backs this scan.
        const rows = await client.query<{
          id: string;
          kind: "sale_post" | "reversal";
          sale_id: string;
          source_system: string;
          external_id: string;
          payload_hash: string;
          sequence: string;
        }>(
          `SELECT id, kind, sale_id, source_system, external_id,
                  payload_hash, sequence::text AS sequence
             FROM erpnext_posting_status
            WHERE status = 'pending'
              AND ($1::bigint IS NULL OR sequence > $1::bigint)
            ORDER BY sequence
            LIMIT $2`,
          [input.since !== null ? input.since.toString() : null, limit],
        );

        const items: PostingWorkItem[] = [];
        for (const row of rows.rows) {
          const item = await buildWorkItem(client, {
            id: row.id,
            kind: row.kind,
            saleId: row.sale_id,
            sourceSystem: row.source_system,
            externalId: row.external_id,
            payloadHash: row.payload_hash,
            sequence: row.sequence,
          });
          if (item) items.push(item);
        }

        const advanced =
          rows.rows.length > 0
            ? rows.rows[rows.rows.length - 1]!.sequence
            : null;
        const nextPageToken = rows.rows.length === limit ? advanced : null;

        return { items, cursor: advanced, nextPageToken };
      },
    );
  }
}
