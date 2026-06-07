/**
 * ErpnextSyncOpsReadModelService — 025 read-model (compute-on-read).
 *
 * Reads 015 `erpnext_posting_status` + 017 `erpnext_reconciliation_run`/`_result`
 * in place (READ-NOT-MIRROR), tenant-scoped under `runWithTenantContext`
 * (RLS fail-closed). No write, no new table. The 020 connector_health + 021
 * product_master domains are reported `not_available` (forward-compat stub) until
 * those specs ship. The 015/017 source tables carry NO money/valuation column, so
 * this read-model surfaces none.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";

/** A sync-ops domain rollup (wire shape — mirrors the contract `DomainSummary`). */
export interface DomainSummary {
  readonly domain:
    | "posting"
    | "reconciliation"
    | "connector_health"
    | "product_master";
  readonly status: "ok" | "attention" | "not_available";
  readonly headlineCount: number | null;
  readonly detail: string | null;
}

export interface SyncOpsSummaryBody {
  readonly domains: readonly DomainSummary[];
}

export interface SummaryInput {
  readonly tenantId: string;
  readonly storeId?: string;
}

/** US2 — one dead-letter backlog row (wire shape; mirrors the contract). */
export interface PostingBacklogItem {
  readonly postingStatusId: string;
  readonly kind: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly status: "permanently_rejected";
  readonly rejectionClass: string | null;
  readonly deadLetteredAt: string;
}

/** US3 — one reconciliation run (wire shape; mirrors the contract). */
export interface ReconciliationRunView {
  readonly runId: string;
  readonly storeId: string;
  readonly kind: string;
  readonly trigger: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly mismatchSummary: Record<string, number> | null;
}

export interface ListInput {
  readonly tenantId: string;
  readonly storeId?: string;
  readonly cursor: bigint | null;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

const LIST_MAX_PAGE = 200;

@Injectable()
export class ErpnextSyncOpsReadModelService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * US1 — the consolidated sync-ops summary. Aggregates 015 posting health
   * (dead-letter backlog count) + 017 reconciliation health (latest run + open
   * mismatch count); 020/021 are `not_available`. Tenant-scoped via RLS; optional
   * store filter. Compute-on-read — no mirror.
   */
  async getSummary(input: SummaryInput): Promise<SyncOpsSummaryBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const storeId = input.storeId ?? null;

        // --- posting health: dead-letter backlog size (015) -----------------
        const posting = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM erpnext_posting_status
            WHERE status = 'permanently_rejected'
              AND ($1::uuid IS NULL OR store_id = $1::uuid)`,
          [storeId],
        );
        const postingBacklog = Number(posting.rows[0]?.count ?? "0");

        // --- reconciliation health: open mismatch count + latest run (017) --
        const openMismatches = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM erpnext_reconciliation_result r
            WHERE r.result_state = 'open'`,
        );
        const openMismatchCount = Number(openMismatches.rows[0]?.count ?? "0");

        const latestRun = await client.query<{
          status: string;
          started_at: string;
        }>(
          `SELECT status, started_at
             FROM erpnext_reconciliation_run
            WHERE ($1::uuid IS NULL OR store_id = $1::uuid)
            ORDER BY started_at DESC
            LIMIT 1`,
          [storeId],
        );
        const latest = latestRun.rows[0] ?? null;

        const domains: DomainSummary[] = [
          {
            domain: "posting",
            status: postingBacklog > 0 ? "attention" : "ok",
            headlineCount: postingBacklog,
            detail:
              postingBacklog > 0
                ? `${postingBacklog} posting(s) in the dead-letter backlog`
                : "No posting dead-letters",
          },
          {
            domain: "reconciliation",
            status: openMismatchCount > 0 ? "attention" : "ok",
            headlineCount: openMismatchCount,
            detail: latest
              ? `Latest run ${latest.status}`
              : "No reconciliation runs yet",
          },
          // 020/021 forward-compat stub — not yet built.
          {
            domain: "connector_health",
            status: "not_available",
            headlineCount: null,
            detail: "Connector health (020) not yet available",
          },
          {
            domain: "product_master",
            status: "not_available",
            headlineCount: null,
            detail: "Product-master reconciliation (021) not yet available",
          },
        ];

        return { domains };
      },
    );
  }

  /**
   * US2 — the posting dead-letter backlog (a read-projection over 015
   * `erpnext_posting_status` WHERE status='permanently_rejected'). Cursor on the
   * `sequence` (single global IDENTITY); newest scanned in `sequence` order so the
   * cursor is stable + gap-free. No new DB index (SC-007 — the existing pending
   * index does not back this scan; report-only perf note).
   */
  async listPostingBacklog(input: ListInput): Promise<Page<PostingBacklogItem>> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const rows = await client.query<{
          id: string;
          kind: string;
          source_system: string;
          external_id: string;
          rejection_category: string | null;
          updated_at: string;
          sequence: string;
        }>(
          `SELECT id, kind, source_system, external_id, rejection_category,
                  updated_at, sequence::text AS sequence
             FROM erpnext_posting_status
            WHERE status = 'permanently_rejected'
              AND ($1::bigint IS NULL OR sequence > $1::bigint)
              AND ($2::uuid IS NULL OR store_id = $2::uuid)
            ORDER BY sequence
            LIMIT $3`,
          [
            input.cursor !== null ? input.cursor.toString() : null,
            input.storeId ?? null,
            limit,
          ],
        );
        const items: PostingBacklogItem[] = rows.rows.map((r) => ({
          postingStatusId: r.id,
          kind: r.kind,
          sourceSystem: r.source_system,
          externalId: r.external_id,
          status: "permanently_rejected",
          rejectionClass: r.rejection_category,
          deadLetteredAt: new Date(r.updated_at).toISOString(),
        }));
        const nextCursor =
          rows.rows.length === limit
            ? rows.rows[rows.rows.length - 1]!.sequence
            : null;
        return { items, nextCursor };
      },
    );
  }

  /**
   * US3 — reconciliation run-history (a read-projection over 017
   * `erpnext_reconciliation_run`), newest-first. Cursor is the epoch-millis of the
   * last row's `started_at` (the table is indexed `(tenant_id, started_at DESC)`).
   * `mismatchSummary` comes from the run's `summary` jsonb (per-class counts).
   */
  async listReconciliationRuns(
    input: ListInput,
  ): Promise<Page<ReconciliationRunView>> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Cursor encodes the last seen started_at as epoch millis; newer→older.
        const cursorMs = input.cursor !== null ? input.cursor.toString() : null;
        const rows = await client.query<{
          id: string;
          store_id: string;
          kind: string;
          trigger: string;
          status: string;
          started_at: string;
          finished_at: string | null;
          summary: Record<string, number> | null;
        }>(
          `SELECT id, store_id, kind, trigger, status,
                  started_at, finished_at, summary
             FROM erpnext_reconciliation_run
            WHERE ($1::uuid IS NULL OR store_id = $1::uuid)
              AND ($2::bigint IS NULL
                   OR started_at < to_timestamp($2::bigint / 1000.0))
            ORDER BY started_at DESC
            LIMIT $3`,
          [input.storeId ?? null, cursorMs, limit],
        );
        const items: ReconciliationRunView[] = rows.rows.map((r) => ({
          runId: r.id,
          storeId: r.store_id,
          kind: r.kind,
          trigger: r.trigger,
          status: r.status,
          startedAt: new Date(r.started_at).toISOString(),
          finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
          mismatchSummary: r.summary ?? null,
        }));
        const nextCursor =
          rows.rows.length === limit
            ? Date.parse(
                rows.rows[rows.rows.length - 1]!.started_at,
              ).toString()
            : null;
        return { items, nextCursor };
      },
    );
  }
}
