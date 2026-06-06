/**
 * ErpnextReconciliationService — 017.
 *
 * The DP2-side reconciliation/repair engine. US1 (this slice) is a PURE READ:
 *   - `listPostingBacklog()` — a read-projection of the 015 `erpnext_posting_status`
 *     rows with `status='permanently_rejected'` for the session tenant, cursor-
 *     ordered by the row `sequence` (the 015 feed-cursor column, stable on a
 *     dead-lettered row). 017 READS the 015 dead-letters in place — it never
 *     mirrors them into a 017 table (READ-NOT-MIRROR / R2).
 *
 * Repair (US2) + the stock run/report (US3) extend this service. All queries run
 * under the caller's tenant GUC via `runWithTenantContext` (tenant from the
 * dashboard session principal, never the body — §XII); RLS scopes the rows.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";
import {
  toBacklogItem,
  type PostingBacklogItem,
  type PostingDeadletterRow,
} from "./reconciliation-report.projection";

/** Hard ceiling on a single backlog page — the 012/009 500/req convention. */
export const BACKLOG_MAX_PAGE = 500;

export interface ListBacklogInput {
  readonly tenantId: string;
  /** Opaque cursor — the last `sequence` the operator saw. null = from start. */
  readonly cursor: bigint | null;
  readonly limit: number;
  readonly storeId?: string;
  readonly rejectionCategory?: string;
}

export interface ListBacklogResult {
  readonly items: readonly PostingBacklogItem[];
  /** The advanced opaque cursor (the last item's sequence), or null on empty/last. */
  readonly nextCursor: string | null;
}

interface BacklogDbRow extends PostingDeadletterRow {
  readonly sequence: string;
}

@Injectable()
export class ErpnextReconciliationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * List the tenant's posting dead-letter backlog (US1) — a read-projection over
   * the 015 erpnext_posting_status rows where status='permanently_rejected'.
   * Cursor-ordered by the row `sequence`; optional store + class filters.
   */
  async listPostingBacklog(input: ListBacklogInput): Promise<ListBacklogResult> {
    const limit = Math.min(Math.max(1, input.limit), BACKLOG_MAX_PAGE);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // RLS scopes to the session tenant. The pending-feed index does not back
        // this (status='permanently_rejected'), but the table is small relative
        // to total postings; the provenance index assists the common scans.
        const rows = await client.query<BacklogDbRow>(
          `SELECT id, kind, rejection_category, sale_id,
                  source_system, external_id, updated_at,
                  sequence::text AS sequence
             FROM erpnext_posting_status
            WHERE status = 'permanently_rejected'
              AND ($1::bigint IS NULL OR sequence > $1::bigint)
              AND ($2::uuid IS NULL OR store_id = $2::uuid)
              AND ($3::text IS NULL OR rejection_category = $3::text)
            ORDER BY sequence
            LIMIT $4`,
          [
            input.cursor !== null ? input.cursor.toString() : null,
            input.storeId ?? null,
            input.rejectionCategory ?? null,
            limit,
          ],
        );

        const items = rows.rows.map(toBacklogItem);
        const advanced =
          rows.rows.length === limit && rows.rows.length > 0
            ? rows.rows[rows.rows.length - 1]!.sequence
            : null;
        return { items, nextCursor: advanced };
      },
    );
  }
}
