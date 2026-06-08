/**
 * ErpnextBinViewService — 019-T040 DP2-side bin-view feed/report runtime.
 *
 * Implements the two operations of the shipped
 * `packages/contracts/openapi/erpnext-connector/stock-view.yaml`:
 *
 *   - `binViewPullRequests` (feed): project OPEN 017 stock runs (status='running',
 *     store has an active 014 `stock` warehouse map) into `BinViewRequest` feed
 *     items — one per (run, itemWindow). A wanted Bin-view read exists only while a
 *     run is `running`; a completed run is never offered. READ-ONLY, idempotent on
 *     the opaque `since` cursor (mirrors the 015 `pullPostings` feed). 019 has no
 *     posting-status-like table, so the cursor derives from RUN ordering
 *     (`started_at, id`), NOT a sequence column.
 *
 *   - `reportSnapshot` (report): record the connector's point-in-time ERPNext-Bin
 *     snapshot run-scoped (lands in 019-T040-REPORT). NOT a standing Bin mirror
 *     (FR-009) — values go to `erpnext_reconciliation_run.summary.bin_view_report`
 *     via a MERGE write (never a bare overwrite — keeps the T041 counts key safe).
 *
 * §IX: DP2 makes NO outbound ERPNext HTTP — it EXPOSES these endpoints; the
 * connector (separate repo) CALLS them. Tenant scope comes from the connector
 * principal only (§XII); RLS scopes every read/write to `app.current_tenant`.
 *
 * `requestRef` is DERIVED deterministically (`deterministicId(NS, runId:windowSeq)`)
 * so a pulled request is stable across re-pulls + bindable on the report WITHOUT a
 * request table (Option B — zero `packages/db` surface, FR-009).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { deterministicId } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";

/** Max feed items per page (009/012 ceiling). */
const BIN_VIEW_FEED_MAX_PAGE = 500;
/** Per-request item-window cap — equals the report `entries` ceiling (the contract invariant). */
const BIN_VIEW_WINDOW_MAX_ITEMS = 500;
/**
 * Fixed UUID namespace for deterministic `requestRef` derivation. A constant
 * (not random) so the same (run, window) always derives the same ref.
 */
const BIN_VIEW_REQUEST_NS = "0190b1de-0000-7000-8000-0000000be019";

/** A bounded item slice of a warehouse's Bin (≤500 items). */
export interface BinViewItemWindow {
  readonly windowSeq: number;
  readonly maxItems: number;
  readonly fromItemRef: string | null;
  readonly toItemRef: string | null;
}

/** One wanted ERPNext-Bin read (DP2 → connector). Carries no bin data. */
export interface BinViewRequest {
  readonly requestRef: string;
  readonly storeId: string;
  readonly erpnextWarehouseRef: string;
  readonly runRef: string;
  readonly itemWindow: BinViewItemWindow;
  readonly itemCursor: string;
}

export interface PullRequestsInput {
  readonly tenantId: string;
  readonly since: string | null;
  readonly limit: number;
}

export interface PullRequestsResult {
  readonly items: readonly BinViewRequest[];
  readonly cursor: string | null;
  readonly nextPageToken: string | null;
}

interface RunRow {
  run_id: string;
  store_id: string;
  erpnext_warehouse_ref: string;
  started_at: string;
}

@Injectable()
export class ErpnextBinViewService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Pull a cursor-ordered page of wanted Bin-view reads. Read-only; orders by the
   * run's `(started_at, id)`; offers only `running` stock runs whose store has an
   * active 014 `stock` mapping; caps at `BIN_VIEW_FEED_MAX_PAGE`. v1 emits one
   * window (windowSeq 0) per run.
   */
  async pullRequests(input: PullRequestsInput): Promise<PullRequestsResult> {
    const limit = Math.min(Math.max(1, input.limit), BIN_VIEW_FEED_MAX_PAGE);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<PullRequestsResult> => {
        // Open stock runs on a mapped store, ordered + capped, after the opaque
        // `since` cursor. RLS scopes to the connector principal's tenant. The
        // cursor is the prior page's last run id (text), matched on (started_at, id).
        const rows = await client.query<RunRow>(
          `SELECT run.id AS run_id,
                  run.store_id,
                  whm.erpnext_warehouse_ref,
                  run.started_at::text AS started_at
             FROM erpnext_reconciliation_run run
             JOIN erpnext_warehouse_map whm
               ON whm.store_id = run.store_id
              AND whm.purpose = 'stock'
              AND whm.retired_at IS NULL
            WHERE run.kind = 'stock'
              AND run.status = 'running'
              AND ($1::uuid IS NULL OR run.id > $1::uuid)
            ORDER BY run.started_at, run.id
            LIMIT $2`,
          [input.since, limit],
        );

        const items: BinViewRequest[] = rows.rows.map((row) => {
          const windowSeq = 0;
          const requestRef = deterministicId(
            BIN_VIEW_REQUEST_NS,
            `${row.run_id}:${windowSeq}`,
          );
          return {
            requestRef,
            storeId: row.store_id,
            erpnextWarehouseRef: row.erpnext_warehouse_ref,
            runRef: row.run_id,
            itemWindow: {
              windowSeq,
              maxItems: BIN_VIEW_WINDOW_MAX_ITEMS,
              fromItemRef: null,
              toItemRef: null,
            },
            // Opaque advanced cursor after this request item — the run id.
            itemCursor: row.run_id,
          };
        });

        const advanced =
          rows.rows.length > 0 ? rows.rows[rows.rows.length - 1]!.run_id : null;
        const nextPageToken = rows.rows.length === limit ? advanced : null;

        return { items, cursor: advanced, nextPageToken };
      },
    );
  }
}
