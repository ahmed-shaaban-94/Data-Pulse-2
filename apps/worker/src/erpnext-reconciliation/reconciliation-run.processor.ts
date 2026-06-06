/**
 * 017-US3 — `ReconciliationRunProcessor` (the stock reconciliation run).
 *
 * Compares DP2 operational on-hand (009 `stock_movements` signed SUM) against the
 * connector's ERPNext-Bin view for the 014-mapped warehouse, per item, and
 * persists one `erpnext_reconciliation_result` per compared item classified in
 * **014's vocabulary** (014 data-model §6.2). The DP2 009 ledger + the 008 sale
 * fact are NEVER mutated (read + report only, §IX / FR-013).
 *
 * DIRECTLY-INVOKABLE class (the 015 `PostingRequestedConsumer` precedent): it
 * takes a `Pool` + the ERPNext-Bin seam and exposes `process(runId)`. The live
 * trigger→queue→processor WIRING (a BullMQ queue or an outbox event-type) is a
 * SEPARATE deferred slice — registering an outbox event-type / a queue touches
 * the [GATED] `packages/db` outbox registry / `worker.module` and is out of US3's
 * approved scope. In production-without-wiring a triggered run stays `running`
 * until the wiring slice lands (documented in wave-status — NOT live end-to-end).
 *
 * ERPNext-Bin seam (R3, stub-tolerant): `fetchBinView` returns a Map<productRef,
 * qty> for the (tenant, store) — the connector (separate repo, ADR 0008) owns the
 * real fetch behind the 012 boundary; DP2 makes NO outbound ERPNext HTTP. An
 * ABSENT/empty view is NOT a failure — every DP2-on-hand item then classes as
 * `dp2_only` (the connector hasn't reported yet).
 *
 * Idempotency: the terminal write is guarded
 * (`UPDATE … SET status='completed' WHERE id=$1 AND status='running'`); a 0-row
 * result means another invocation already finished the run → skip result inserts
 * (the 008 `processed_at IS NULL` convergence precedent). No money column anywhere.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

/** The connector ERPNext-Bin view seam (R3). productRef → ERPNext Bin qty. */
export interface ErpnextBinView {
  fetchBinView(input: {
    tenantId: string;
    storeId: string;
  }): Promise<ReadonlyMap<string, number>>;
}

/** A stub-tolerant view: the connector isn't built yet, so it reports nothing. */
export const EMPTY_BIN_VIEW: ErpnextBinView = {
  async fetchBinView(): Promise<ReadonlyMap<string, number>> {
    return new Map();
  },
};

/** 014's mismatch-class vocabulary (014 data-model §6.2). */
type MismatchClass =
  | "match"
  | "quantity_divergence"
  | "unmapped_store"
  | "unmapped_item"
  | "dp2_only"
  | "erpnext_only"
  | "negative_balance_flagged";

export interface ReconciliationRunResult {
  readonly runId: string;
  readonly status: "completed" | "skipped";
  readonly counts: Readonly<Record<string, number>>;
}

interface OnHandRow {
  tenant_product_ref: string;
  on_hand: string;
  has_confirmed_map: boolean;
}

export class ReconciliationRunProcessor {
  constructor(
    private readonly pool: Pool,
    private readonly bin: ErpnextBinView,
  ) {}

  /**
   * Execute one stock reconciliation run. Reads the run's (tenant, store), the
   * 014 mapping, DP2 on-hand (009), and the connector Bin view; persists one
   * classified result per item; flips the run running→completed (guarded).
   */
  async process(input: { runId: string; tenantId: string }): Promise<ReconciliationRunResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReconciliationRunResult> => {
        const run = await client.query<{ store_id: string; status: string }>(
          `SELECT store_id, status FROM erpnext_reconciliation_run
            WHERE id = $1 FOR UPDATE`,
          [input.runId],
        );
        const r = run.rows[0];
        if (!r || r.status !== "running") {
          // Already finished by another invocation (idempotent no-op) or absent.
          return { runId: input.runId, status: "skipped", counts: {} };
        }
        const storeId = r.store_id;

        // (1) unmapped_store is a whole-run precondition: no active 014 mapping →
        // the run cannot compare. Record ONE unmapped_store result + complete.
        const wh = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM erpnext_warehouse_map
            WHERE store_id = $1 AND retired_at IS NULL`,
          [storeId],
        );
        if (Number(wh.rows[0]?.count ?? "0") === 0) {
          await this.insertResult(client, input.runId, input.tenantId, {
            mismatchClass: "unmapped_store",
            sourceRefId: null,
          });
          await this.complete(client, input.runId);
          return { runId: input.runId, status: "completed", counts: { unmapped_store: 1 } };
        }

        // (2) DP2 on-hand per product (009 signed SUM) + whether the product has a
        // confirmed 013 item map (for unmapped_item classification).
        const dp2 = await client.query<OnHandRow>(
          `SELECT sm.tenant_product_ref,
                  COALESCE(SUM(sm.quantity), 0)::text AS on_hand,
                  (im.id IS NOT NULL) AS has_confirmed_map
             FROM stock_movements sm
             LEFT JOIN erpnext_item_map im
               ON im.tenant_product_id = sm.tenant_product_ref
              AND im.state = 'confirmed'
              AND im.retired_at IS NULL
            WHERE sm.store_id = $1 AND sm.tenant_product_ref IS NOT NULL
            GROUP BY sm.tenant_product_ref, im.id`,
          [storeId],
        );

        const binView = await this.bin.fetchBinView({ tenantId: input.tenantId, storeId });

        const counts: Record<string, number> = {};
        const seen = new Set<string>();
        for (const row of dp2.rows) {
          seen.add(row.tenant_product_ref);
          const onHand = Number(row.on_hand);
          const binQty = binView.get(row.tenant_product_ref);
          const cls = this.classify(onHand, row.has_confirmed_map, binQty);
          counts[cls] = (counts[cls] ?? 0) + 1;
          await this.insertResult(client, input.runId, input.tenantId, {
            mismatchClass: cls,
            sourceRefId: row.tenant_product_ref,
            detail: { dp2_on_hand: row.on_hand, erpnext_bin: binQty ?? null },
          });
        }
        // erpnext_only: in the Bin view but with no DP2 on-hand row at all.
        for (const [productRef, binQty] of binView) {
          if (seen.has(productRef)) continue;
          counts["erpnext_only"] = (counts["erpnext_only"] ?? 0) + 1;
          await this.insertResult(client, input.runId, input.tenantId, {
            mismatchClass: "erpnext_only",
            sourceRefId: productRef,
            detail: { dp2_on_hand: null, erpnext_bin: binQty },
          });
        }

        await this.complete(client, input.runId);
        return { runId: input.runId, status: "completed", counts };
      },
    );
  }

  /**
   * 014 §6.3 classification ORDER is load-bearing: negative_balance_flagged is
   * evaluated BEFORE the quantity compare (a negative DP2 on-hand is that class
   * regardless of the ERPNext side, stock-impact §6); then unmapped_item; then
   * presence (dp2_only); then the exact-match delta (v1 no tolerance).
   */
  private classify(
    onHand: number,
    hasConfirmedMap: boolean,
    binQty: number | undefined,
  ): MismatchClass {
    if (onHand < 0) return "negative_balance_flagged";
    if (!hasConfirmedMap) return "unmapped_item";
    if (binQty === undefined) return "dp2_only";
    if (onHand !== binQty) return "quantity_divergence";
    return "match";
  }

  private async insertResult(
    client: PoolClient,
    runId: string,
    tenantId: string,
    opts: {
      mismatchClass: MismatchClass;
      sourceRefId: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO erpnext_reconciliation_result
         (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state, detail)
       VALUES ($1, $2, $3, $4, $5, 'open', $6::jsonb)`,
      [
        newId(),
        runId,
        tenantId,
        opts.mismatchClass,
        opts.sourceRefId,
        opts.detail ? JSON.stringify(opts.detail) : null,
      ],
    );
  }

  /** Guarded terminal write — 0 rows means another invocation already finished it. */
  private async complete(client: PoolClient, runId: string): Promise<void> {
    await client.query(
      `UPDATE erpnext_reconciliation_run
          SET status = 'completed', finished_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [runId],
    );
  }
}
