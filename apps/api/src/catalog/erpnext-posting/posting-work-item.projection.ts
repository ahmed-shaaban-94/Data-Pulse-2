/**
 * posting-work-item.projection.ts — 015-RESOLVE + the 012 work-item wire shape.
 *
 * TWO resolution moments, deliberately split (the contract's idempotent-replay
 * obligation forbids a write side-effect on the GET feed):
 *
 *   1. ELIGIBILITY — at row CREATION (the `erpnext.posting.requested` consumer).
 *      `resolveEligibility()` joins each `sale_lines.tenant_product_ref` →
 *      a CONFIRMED `erpnext_item_map` row and the sale's store →
 *      `erpnext_warehouse_map`. Resolvable → the row is `pending` (postable);
 *      unresolvable → `permanently_rejected` BEFORE the work-item is ever offered
 *      (rider R2: "DP2 resolves at projection, fails-to-DLQ before offered").
 *
 *   2. WIRE ASSEMBLY — at PULL (the `connectorPullPostings` feed). `buildWorkItem()`
 *      is a pure read: it re-joins the (already-`pending`) row's sale + lines +
 *      confirmed item-map + warehouse to populate the 012 `PostingWorkItem`
 *      (each line's `erpnextItemRef` resolved). NO status mutation → re-pulling
 *      the same cursor yields the same logical set (012 idempotent replay).
 *
 * The resolution rules (data-model §4, rider R3/R4/R5):
 *   - a line resolves only against a CONFIRMED map (`state='confirmed' AND
 *     retired_at IS NULL`); a `suggested` map counts as unmapped;
 *   - an ad-hoc line (null `tenant_product_ref`, FR-004) is unresolvable;
 *   - an unmapped line → `unmapped_item`; no substitute item (R3);
 *   - no warehouse for the store → `unmapped_store`; never guess (R5);
 *   - a resolution failure NEVER mutates the 008 sale fact and is NEVER routed
 *     into the unknown-items queue (R4) — it is a reconciliation case (017).
 *
 * All queries run under the caller's tenant GUC (the caller wraps in
 * `runWithTenantContext`); RLS does the tenant scoping.
 */
import type { PoolClient } from "pg";

/** The 012 RejectionReason.category values 015 produces. */
export type RejectionCategory = "unmapped_item" | "unmapped_store";

/** Outcome of the creation-time eligibility resolution. */
export type EligibilityResult =
  | { readonly status: "pending" }
  | {
      readonly status: "permanently_rejected";
      readonly rejectionCategory: RejectionCategory;
    };

/**
 * Resolve whether a sale is postable, at row-creation time. Joins each line to a
 * confirmed item-map and the store to a warehouse map. Returns `pending` when
 * every line resolves AND the store maps; otherwise `permanently_rejected` with
 * the nearest 012 category. Read-only — the CALLER persists the verdict.
 */
export async function resolveEligibility(
  client: PoolClient,
  input: { readonly saleId: string; readonly storeId: string },
): Promise<EligibilityResult> {
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

  // (b) every line → a CONFIRMED, non-retired item map. A null tenant_product_ref
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

// ---------------------------------------------------------------------------
// Wire shape — the 012 PostingWorkItem (subset 015 populates in the interim mode)
// ---------------------------------------------------------------------------

/** A 012 SaleLine projection line (interim mode: no tender). */
export interface WorkItemLine {
  readonly lineName: string;
  readonly unitPrice: string;
  readonly currencyCode: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
  readonly unit: string;
  /** The DP2-resolved ERPNext Item identity (required on every OFFERED line). */
  readonly erpnextItemRef: string;
  readonly tenantProductRef: string | null;
}

/** A 012 PostingWorkItem (sale_post; reversal adds reversalOf in US3). */
export interface PostingWorkItem {
  readonly workItemRef: string;
  readonly kind: "sale_post" | "reversal";
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly payloadHash: string;
  readonly businessDate: string;
  readonly sale: {
    readonly saleRef: string;
    readonly storeId: string;
    readonly currencyCode: string;
    readonly posTotal: string;
    readonly occurredAt: string;
    readonly businessDate: string;
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly lines: readonly WorkItemLine[];
  };
  readonly itemCursor: string;
}

/**
 * Build the 012 wire work-item for one ALREADY-`pending` status row (pull-time,
 * read-only). Re-joins the sale + frozen lines + confirmed item-map to populate
 * each line's `erpnextItemRef`. Money is emitted as the exact-decimal strings the
 * DB holds (no float, §III). Returns null if the row's sale/lines are not found
 * under the current tenant (defensive; the feed filters those out).
 */
export async function buildWorkItem(
  client: PoolClient,
  row: {
    readonly id: string;
    readonly kind: "sale_post" | "reversal";
    readonly saleId: string;
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly payloadHash: string;
    readonly sequence: string;
  },
): Promise<PostingWorkItem | null> {
  const sale = await client.query<{
    id: string;
    store_id: string;
    currency_code: string;
    pos_total: string;
    occurred_at: Date;
    business_date: string;
    source_system: string;
    external_id: string;
  }>(
    `SELECT id, store_id, currency_code, pos_total::text AS pos_total,
            occurred_at, business_date::text AS business_date,
            source_system, external_id
       FROM sales WHERE id = $1`,
    [row.saleId],
  );
  const s = sale.rows[0];
  if (!s) return null;

  const lines = await client.query<{
    line_name: string;
    unit_price: string;
    currency_code: string;
    quantity: string;
    line_amount: string;
    tax_amount: string | null;
    unit: string;
    erpnext_item_ref: string | null;
    tenant_product_ref: string | null;
  }>(
    `SELECT sl.line_name, sl.unit_price::text AS unit_price, sl.currency_code,
            sl.quantity::text AS quantity, sl.line_amount::text AS line_amount,
            sl.tax_amount::text AS tax_amount, sl.unit,
            m.erpnext_item_ref, sl.tenant_product_ref::text AS tenant_product_ref
       FROM sale_lines sl
       LEFT JOIN erpnext_item_map m
         ON m.tenant_product_id = sl.tenant_product_ref
        AND m.state = 'confirmed'
        AND m.retired_at IS NULL
      WHERE sl.sale_id = $1
      ORDER BY sl.id`,
    [row.saleId],
  );

  const wireLines: WorkItemLine[] = lines.rows.map((l) => ({
    lineName: l.line_name,
    unitPrice: l.unit_price,
    currencyCode: l.currency_code,
    quantity: l.quantity,
    lineAmount: l.line_amount,
    taxAmount: l.tax_amount,
    unit: l.unit,
    // A `pending` row is only created when eligibility resolved, so every line
    // has a confirmed map — but stay defensive: an empty ref would be a bug, not
    // a silently-shipped null.
    erpnextItemRef: l.erpnext_item_ref ?? "",
    tenantProductRef: l.tenant_product_ref,
  }));

  return {
    workItemRef: row.id,
    kind: row.kind,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    payloadHash: row.payloadHash,
    businessDate: s.business_date,
    sale: {
      saleRef: s.id,
      storeId: s.store_id,
      currencyCode: s.currency_code,
      posTotal: s.pos_total,
      occurredAt: s.occurred_at.toISOString(),
      businessDate: s.business_date,
      sourceSystem: s.source_system,
      externalId: s.external_id,
      lines: wireLines,
    },
    itemCursor: row.sequence,
  };
}
