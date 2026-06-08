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
 *     (`run.id`, so the keyset cursor key == the sort key), NOT a sequence column.
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
/** UUID shape guard for the opaque feed cursor (malformed → from-start, not 500). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised when a `requestRef` does not resolve to a running run in the tenant. */
export class BinViewNotFoundError extends Error {
  constructor() {
    super("Bin-view request not found.");
    this.name = "BinViewNotFoundError";
  }
}

/** Raised when a `requestRef` already has a DIFFERENT recorded report (O-3 conflict). */
export class BinViewConflictError extends Error {
  constructor() {
    super("This bin-view request was already reported with a different snapshot.");
    this.name = "BinViewConflictError";
  }
}

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

/** One reported ERPNext-Bin entry (connector → DP2). */
export interface BinEntryInput {
  readonly erpnextItemRef: { readonly doctype: "Item"; readonly name: string };
  readonly quantity: string;
  readonly stockUom: string;
}

/** The connector's point-in-time snapshot report body. */
export interface SnapshotReportBody {
  readonly entries: readonly BinEntryInput[];
  readonly readAt: string;
}

export interface ReportSnapshotInput {
  readonly tenantId: string;
  readonly requestRef: string;
  readonly body: SnapshotReportBody;
  readonly idempotencyKey: string;
}

/** The recorded-report projection (DP2 → connector). */
export interface RecordedBinView {
  readonly requestRef: string;
  readonly runRef: string;
  readonly erpnextWarehouseRef: string;
  readonly acceptedEntryCount: number;
  readonly readAt: string;
  readonly recordedAt: string;
}

export interface ReportSnapshotResult {
  readonly replayed: boolean;
  readonly view: RecordedBinView;
}

/** What lands in `run.summary.bin_view_report` (run-scoped evidence, Option B). */
interface StoredBinViewReport {
  readonly requestRef: string;
  readonly runRef: string;
  readonly erpnextWarehouseRef: string;
  readonly readAt: string;
  readonly recordedAt: string;
  readonly acceptedEntryCount: number;
  readonly entries: ReadonlyArray<{
    readonly erpnextItemRef: string;
    readonly tenant_product_ref: string | null;
    readonly quantity: string;
    readonly stockUom: string;
  }>;
}

@Injectable()
export class ErpnextBinViewService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Pull a cursor-ordered page of wanted Bin-view reads. Read-only; orders by the
   * run's `id` (keyset cursor key == sort key); offers only `running` stock runs whose store has an
   * active 014 `stock` mapping; caps at `BIN_VIEW_FEED_MAX_PAGE`. v1 emits one
   * window (windowSeq 0) per run.
   */
  async pullRequests(input: PullRequestsInput): Promise<PullRequestsResult> {
    const limit = Math.min(Math.max(1, input.limit), BIN_VIEW_FEED_MAX_PAGE);
    // The cursor is opaque on the wire (the DTO accepts any non-empty string), but
    // v1 encodes it as a run id (uuid). A malformed cursor is treated as
    // from-start (null) rather than a 500 on a bad `::uuid` cast — the feed is a
    // pure read, so re-baselining is harmless + idempotent.
    const since = input.since && UUID_RE.test(input.since) ? input.since : null;

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<PullRequestsResult> => {
        // Open stock runs on a mapped store, ordered + capped, after the opaque
        // `since` cursor. RLS scopes to the connector principal's tenant. The
        // cursor is the prior page's last run id; keyset on run.id (cursor==sort).
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
            ORDER BY run.id
            LIMIT $2`,
          [since, limit],
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

  /**
   * Record the connector's point-in-time ERPNext-Bin snapshot for a pulled
   * `requestRef`. Resolves the request to its `running` stock run + active 014
   * mapping (cross-tenant/unknown → non-disclosing `BinViewNotFoundError`),
   * reverse-resolves each `erpnextItemRef` → `tenant_product_ref` via the confirmed
   * 013 map (an unmapped ref is recorded with `tenant_product_ref: null`), and
   * MERGE-writes the snapshot into `run.summary.bin_view_report` (Option B — NO
   * standing Bin mirror, FR-009). Exact-decimal quantity STRINGs are preserved
   * verbatim (§III). NEVER touches the 009 ledger or the 008 sale fact (§IX).
   *
   * O-3 idempotency: if a report already exists for this `requestRef`, the SAME
   * logical report replays (`replayed: true`, stable body); a DIFFERENT one →
   * `BinViewConflictError` (the stored report wins; never an overwrite).
   */
  async reportSnapshot(input: ReportSnapshotInput): Promise<ReportSnapshotResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReportSnapshotResult> => {
        // Resolve the request → its running run + active 014 mapping. The
        // requestRef is derived from (run, window); re-derive over running stock
        // runs on a mapped store and match. RLS scopes to the tenant, so a
        // cross-tenant ref reads nothing → non-disclosing not-found.
        const runRow = await client.query<{
          run_id: string;
          erpnext_warehouse_ref: string;
          summary: Record<string, unknown> | null;
        }>(
          `SELECT run.id AS run_id,
                  whm.erpnext_warehouse_ref,
                  run.summary
             FROM erpnext_reconciliation_run run
             JOIN erpnext_warehouse_map whm
               ON whm.store_id = run.store_id
              AND whm.purpose = 'stock'
              AND whm.retired_at IS NULL
            WHERE run.kind = 'stock'
              AND run.status = 'running'
            FOR UPDATE OF run`,
        );
        // The derived requestRef binds to exactly one (run, window=0). Re-derive
        // per candidate run and match — v1 has a single window per run.
        const match = runRow.rows.find(
          (r) =>
            deterministicId(BIN_VIEW_REQUEST_NS, `${r.run_id}:0`) ===
            input.requestRef,
        );
        if (!match) throw new BinViewNotFoundError();

        // Reverse-resolve erpnextItemRef → tenant_product_ref (confirmed 013 map),
        // BATCHED into ONE query (= ANY) — not N per-entry round-trips. An unmapped
        // ref records tenant_product_ref: null (the 017 run classes it erpnext_only
        // later) — never a crash. `latest mapping wins` (ORDER BY confirmed_at DESC)
        // makes the resolution deterministic if two confirmed maps share a ref.
        const refNames = Array.from(
          new Set(input.body.entries.map((e) => e.erpnextItemRef.name)),
        );
        const resolvedMap = new Map<string, string>();
        if (refNames.length > 0) {
          const maps = await client.query<{
            erpnext_item_ref: string;
            tenant_product_id: string;
          }>(
            `SELECT DISTINCT ON (erpnext_item_ref) erpnext_item_ref, tenant_product_id
               FROM erpnext_item_map
              WHERE erpnext_item_ref = ANY($1::text[])
                AND state = 'confirmed'
                AND retired_at IS NULL
              ORDER BY erpnext_item_ref, confirmed_at DESC`,
            [refNames],
          );
          for (const r of maps.rows) {
            resolvedMap.set(r.erpnext_item_ref, r.tenant_product_id);
          }
        }
        const resolvedEntries: StoredBinViewReport["entries"][number][] =
          input.body.entries.map((e) => ({
            erpnextItemRef: e.erpnextItemRef.name,
            tenant_product_ref: resolvedMap.get(e.erpnextItemRef.name) ?? null,
            quantity: e.quantity,
            stockUom: e.stockUom,
          }));

        // O-3: an existing report for this requestRef → replay (same) or conflict.
        const existing = (match.summary as { bin_view_report?: StoredBinViewReport } | null)
          ?.bin_view_report;
        if (existing && existing.requestRef === input.requestRef) {
          if (this.sameLogicalReport(existing, input, resolvedEntries)) {
            return { replayed: true, view: this.project(existing) };
          }
          throw new BinViewConflictError();
        }

        const recordedAt = new Date().toISOString();
        const stored: StoredBinViewReport = {
          requestRef: input.requestRef,
          runRef: match.run_id,
          erpnextWarehouseRef: match.erpnext_warehouse_ref,
          readAt: input.body.readAt,
          recordedAt,
          acceptedEntryCount: resolvedEntries.length,
          entries: resolvedEntries,
        };

        // MERGE write — never a bare overwrite (keeps a future T041 counts key
        // under summary safe). COALESCE handles the NULL-summary first write.
        await client.query(
          `UPDATE erpnext_reconciliation_run
              SET summary = COALESCE(summary, '{}'::jsonb)
                            || jsonb_build_object('bin_view_report', $2::jsonb),
                  updated_at = now()
            WHERE id = $1 AND status = 'running'`,
          [match.run_id, JSON.stringify(stored)],
        );

        return { replayed: false, view: this.project(stored) };
      },
    );
  }

  /** True when an existing stored report matches the incoming one (O-3 echo). */
  private sameLogicalReport(
    existing: StoredBinViewReport,
    input: ReportSnapshotInput,
    resolved: StoredBinViewReport["entries"][number][],
  ): boolean {
    if (existing.readAt !== input.body.readAt) return false;
    if (existing.entries.length !== resolved.length) return false;
    // Compare entry-wise on the connector-reported identity + quantity + uom.
    const key = (e: StoredBinViewReport["entries"][number]): string =>
      `${e.erpnextItemRef}|${e.quantity}|${e.stockUom}`;
    const a = existing.entries.map(key).sort();
    const b = resolved.map(key).sort();
    return a.every((v, i) => v === b[i]);
  }

  /** Project a stored report into the RecordedBinView wire shape. */
  private project(stored: StoredBinViewReport): RecordedBinView {
    return {
      requestRef: stored.requestRef,
      runRef: stored.runRef,
      erpnextWarehouseRef: stored.erpnextWarehouseRef,
      acceptedEntryCount: stored.acceptedEntryCount,
      readAt: stored.readAt,
      recordedAt: stored.recordedAt,
    };
  }
}
