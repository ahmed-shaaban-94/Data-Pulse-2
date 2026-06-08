/**
 * 019-T041 — ReportBackedBinView.
 *
 * The live (report-backed) ErpnextBinView seam: replaces the inert EMPTY_BIN_VIEW
 * by reading the connector-reported snapshot that 019 T040 recorded run-scoped in
 * `erpnext_reconciliation_run.summary.bin_view_report`. Returns a
 * Map<tenant_product_ref, quantityString> for the run — the connector's ERPNext
 * Bin on-hand per item, keyed by the DP2-side-resolved `tenant_product_ref`.
 *
 * §III: the quantity is the EXACT-DECIMAL STRING the connector reported and DP2
 * recorded verbatim — it is returned as-is (never coerced through a JS number).
 *
 * An entry whose `tenant_product_ref` is null (the connector reported an
 * `erpnextItemRef` with no confirmed 013 map) is OMITTED from the compare map —
 * the processor cannot key it to a DP2 product. (A future slice may surface these
 * as an explicit `unmapped_erpnext_item` class; v1 drops them from the qty compare,
 * matching the pre-019 behavior where such items simply never appeared.)
 *
 * Tenant scope: the read runs under the processor's tenant GUC (the processor
 * calls this inside its own `runWithTenantContext`), so RLS scopes the run row.
 * The seam takes a plain `Pool` and a NO-GUC client is NOT used — the processor
 * already holds the tenant context when it calls `fetchBinView`. To stay
 * self-contained, this impl opens its own tenant-scoped read.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import type { ErpnextBinView } from "./reconciliation-run.processor";

interface StoredEntry {
  erpnextItemRef: string;
  tenant_product_ref: string | null;
  quantity: string;
  stockUom: string;
}

interface StoredReport {
  entries?: StoredEntry[];
}

export class ReportBackedBinView implements ErpnextBinView {
  constructor(private readonly pool: Pool) {}

  async fetchBinView(input: {
    tenantId: string;
    storeId: string;
    runId: string;
  }): Promise<ReadonlyMap<string, string>> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReadonlyMap<string, string>> => {
        const r = await client.query<{
          summary: { bin_view_report?: StoredReport } | null;
        }>(
          `SELECT summary FROM erpnext_reconciliation_run WHERE id = $1`,
          [input.runId],
        );
        const report = r.rows[0]?.summary?.bin_view_report;
        const out = new Map<string, string>();
        for (const e of report?.entries ?? []) {
          // Only entries the connector's erpnextItemRef resolved to a DP2 product
          // participate in the qty compare. Last-write-wins on a duplicate ref.
          if (e.tenant_product_ref !== null) {
            out.set(e.tenant_product_ref, e.quantity);
          }
        }
        return out;
      },
    );
  }
}
