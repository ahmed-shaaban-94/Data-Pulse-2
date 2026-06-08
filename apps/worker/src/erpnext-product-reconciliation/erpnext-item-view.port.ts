/**
 * 021-US3 connector ERPNext-item-view SEAM (worker side, T033).
 *
 * The ERPNext side of the two-sided product-master compare is fetched ONLY by the
 * connector (separate repo, ADR 0008) behind the fixed 012 boundary — DP2 makes
 * NO outbound ERPNext HTTP (FR-016). The worker run processor reads the ERPNext
 * side through THIS interface only; v1 wires the EMPTY stub (the view is
 * UNAVAILABLE), so a run completes with DP2-side classes only and NEVER fabricates
 * an `unmapped_erpnext_item` (FR-007 / R3). The live adapter is gated on a future
 * `[GATED]` `021-ITEM-VIEW-CONTRACT` (epic #524).
 *
 * Mirrors the 017 `ErpnextBinView` / `EMPTY_BIN_VIEW` stub-tolerance pattern.
 */

export interface ErpnextItemViewEntry {
  readonly erpnextItemRef: string;
  readonly sellable?: boolean;
  readonly attributes?: Record<string, unknown>;
}

export interface ErpnextItemView {
  readonly status: "available" | "unavailable" | "partial";
  readonly items: readonly ErpnextItemViewEntry[];
}

export interface ErpnextItemViewSource {
  fetch(input: { readonly tenantId: string }): Promise<ErpnextItemView>;
}

/** The v1 stub: UNAVAILABLE, no items — a REPORTED condition, never a failure. */
export const EMPTY_ERPNEXT_ITEM_VIEW: ErpnextItemViewSource = {
  async fetch(): Promise<ErpnextItemView> {
    return { status: "unavailable", items: [] };
  },
};

/** A recorded/stub adapter usable in tests: returns a fixed item view. */
export function recordedItemView(view: ErpnextItemView): ErpnextItemViewSource {
  return {
    async fetch(): Promise<ErpnextItemView> {
      return view;
    },
  };
}
