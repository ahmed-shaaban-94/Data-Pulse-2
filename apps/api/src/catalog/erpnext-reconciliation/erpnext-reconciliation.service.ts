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
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../../auth/auth.module";
import {
  toBacklogItem,
  type PostingBacklogItem,
  type PostingDeadletterRow,
} from "./reconciliation-report.projection";

/** Hard ceiling on a single backlog page — the 012/009 500/req convention. */
export const BACKLOG_MAX_PAGE = 500;

/**
 * The DP2-side retry budget a posting repair resets to (mirrors the 015
 * `POSTING_RETRY_BUDGET`). A row that dead-lettered via `retry_budget_exhausted`
 * carries retry_count at the ceiling; the repair MUST reset it to 0 on re-head,
 * else the connector's first `failed_transient` ack re-dead-letters instantly.
 */
const REPAIR_RESET_RETRY_COUNT = 0;

export type RepairOutcome = "eligible_again" | "still_failing" | "no_op_echo";

export interface RepairPostingInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly workItemRef: string;
}

/** The 012 RecordedRepair wire projection (DP2 → operator). */
export interface RecordedRepair {
  readonly targetKind: "posting" | "stock";
  readonly targetRef: string;
  readonly repairKind: "re_post" | "re_map" | "re_sync" | "drain";
  readonly outcome: RepairOutcome;
  readonly resolvedDocumentRef: string | null;
  readonly recordedAt: string;
}

export interface RepairResult {
  readonly repair: RecordedRepair;
  /** True when the repair hit a no-op echo (already-terminal/in-flight) — controller surfaces 200. */
  readonly replayed: boolean;
}

/** The addressed work-item does not resolve in the tenant scope (RLS 0 rows). 404. */
export class RepairNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "RepairNotFoundError";
  }
}

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

  /**
   * Repair (re-offer) a posting dead-letter (US2). Re-uses the 015 O-3 state
   * machine — re-evaluate 015-RESOLVE, and if it now resolves, flip the 015 row
   * `permanently_rejected → pending` + re-head `sequence` + RESET `retry_count`
   * (so the connector's first `failed_transient` ack doesn't instantly
   * re-dead-letter a `retry_budget_exhausted` row). The connector re-posts via the
   * EXISTING 012 feed/ack — DP2 makes NO outbound ERPNext HTTP. Writes a
   * `repair_attempt` + a platform `audit_events` row IN THE SAME TRANSACTION
   * (FR-014) as the transition. `SELECT … FOR UPDATE` serializes concurrent
   * repairs of one row.
   *
   * Four input statuses (the FOR UPDATE may catch concurrent/stale cases):
   *   - permanently_rejected + resolve OK    → pending (re-head) → eligible_again
   *   - permanently_rejected + resolve fails → no transition     → still_failing
   *   - posted                                → no_op_echo (echo stored document_ref)
   *   - pending (a concurrent repair already re-offered) → no_op_echo, NO re-head
   */
  async repairPosting(input: RepairPostingInput): Promise<RepairResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RepairResult> => {
        const cur = await client.query<{
          status: string;
          document_ref: string | null;
          sale_id: string;
          store_id: string;
        }>(
          `SELECT status, document_ref, sale_id, store_id
             FROM erpnext_posting_status
            WHERE id = $1
            FOR UPDATE`,
          [input.workItemRef],
        );
        const row = cur.rows[0];
        if (!row) throw new RepairNotFoundError();

        // --- Already-terminal (posted) or in-flight (pending): no-op echo -------
        if (row.status === "posted") {
          return this.recordRepair(client, input, "no_op_echo", row.document_ref, true);
        }
        if (row.status === "pending") {
          // A concurrent repair already re-offered it; do NOT re-head again.
          return this.recordRepair(client, input, "no_op_echo", null, true);
        }

        // --- permanently_rejected: re-evaluate 015-RESOLVE ----------------------
        const resolvable = await this.resolvePostingEligibility(client, {
          saleId: row.sale_id,
          storeId: row.store_id,
        });
        if (!resolvable) {
          // Cause still unfixed — stays dead-lettered, returns to the backlog.
          return this.recordRepair(client, input, "still_failing", null, false);
        }

        // Re-offer: flip to pending, re-head the sequence, RESET retry_count.
        // Do NOT touch document_ref (NULL on a non-posted row; the
        // (status='posted')=(document_ref IS NOT NULL) CHECK would otherwise bite).
        await client.query(
          `UPDATE erpnext_posting_status
              SET status = 'pending', sequence = DEFAULT,
                  retry_count = $2, updated_at = now()
            WHERE id = $1`,
          [input.workItemRef, REPAIR_RESET_RETRY_COUNT],
        );
        return this.recordRepair(client, input, "eligible_again", null, false);
      },
    );
  }

  /**
   * 015-RESOLVE re-evaluation (api-side copy; the SQL is duplicated per package,
   * NOT imported across the api/worker boundary — the 015 worker-consumer
   * precedent). Keys on the PARENT `sale_id` (present for both kinds; a reversal's
   * source_ref_id is a terminal-event id with no lines). Returns true iff the
   * store maps to an active warehouse AND every line resolves to a confirmed,
   * non-retired item map.
   */
  private async resolvePostingEligibility(
    client: PoolClient,
    input: { saleId: string; storeId: string },
  ): Promise<boolean> {
    const wh = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_warehouse_map
        WHERE store_id = $1 AND retired_at IS NULL`,
      [input.storeId],
    );
    if (Number(wh.rows[0]?.count ?? "0") === 0) return false;

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
    return Number(unmapped.rows[0]?.count ?? "0") === 0;
  }

  /**
   * Persist the repair: an append-only `repair_attempt` + a platform
   * `audit_events` row IN THE SAME TRANSACTION (FR-014). The audit write is a
   * NEW in-transaction INSERT on the same tenant-scoped client (NOT the async
   * `@Auditable` interceptor, NOT `insertAuditEvent` which grabs its own
   * connection) — so a repair that cannot audit rolls back. No PII in either row.
   */
  private async recordRepair(
    client: PoolClient,
    input: RepairPostingInput,
    outcome: RepairOutcome,
    documentRef: string | null,
    replayed: boolean,
  ): Promise<RepairResult> {
    const r = await client.query<{ created_at: Date }>(
      `INSERT INTO erpnext_reconciliation_repair_attempt
         (id, tenant_id, target_kind, target_ref_id, repair_kind, actor_user_id,
          outcome, resolved_document_ref)
       VALUES ($1, $2, 'posting', $3, 're_post', $4, $5, $6)
       RETURNING created_at`,
      [newId(), input.tenantId, input.workItemRef, input.actorUserId, outcome, documentRef],
    );
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'erpnext_reconciliation.posting.repaired', 'erpnext_posting_status', $4, $5::jsonb)`,
      [
        newId(),
        input.actorUserId,
        input.tenantId,
        input.workItemRef,
        JSON.stringify({ outcome, repair_kind: "re_post" }),
      ],
    );
    return {
      replayed,
      repair: {
        targetKind: "posting",
        targetRef: input.workItemRef,
        repairKind: "re_post",
        outcome,
        resolvedDocumentRef: documentRef,
        recordedAt: r.rows[0]!.created_at.toISOString(),
      },
    };
  }
}
