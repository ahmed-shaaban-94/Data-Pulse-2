/**
 * review-queue-item.dto.ts  (007 — T023)
 *
 * `ReviewQueueItem` — the review-surface projection of an `unknown_items`
 * row. It is the shipped `UnknownItem` wire schema MINUS `sale_context`
 * (data-model §2.1, FR-007 / 006 FR-021a). `sale_context` is descriptive
 * capture metadata that MUST NOT appear on any dashboard-review response;
 * the shipped `UnknownItem` schema retains it solely for the POS capture
 * round-trip (R7.3), which uses `toUnknownWireShape`, NOT this helper.
 *
 * This is the single shared home (R7.2): both catalog controllers import
 * `toReviewQueueItem` —
 *   - unknown-items.controller (list, dismiss, inspect),
 *   - reconciliation.controller (link, create-product).
 * Do NOT duplicate the projection in a controller; do NOT wire it into the
 * POS `toUnknownWireShape` capture path.
 *
 * Contract of record: packages/contracts/openapi/catalog/unknown-items.yaml
 * #/components/schemas/ReviewQueueItem.
 */
import type { UnknownItemRow } from "../unknown-items.service";

/**
 * Wire shape of the contract's `ReviewQueueItem` schema (snake_case).
 *
 * `resolved_product_id` is OPTIONAL — per FR-001a it is present only when the
 * caller may see the product, and the KEY is omitted entirely otherwise (never
 * present-and-null as a suppression signal). The optional type forces every
 * consumer to handle its absence.
 */
export interface ReviewQueueItem {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly identifier_type: string;
  readonly identifier_value: string;
  readonly source_system: string | null;
  readonly resolution_status: "pending" | "resolved" | "dismissed";
  readonly resolution_action: "linked" | "created" | "dismissed" | null;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly resolved_product_id?: string | null;
  readonly encountered_at: string;
}

/**
 * Project an `UnknownItemRow` to the review-surface `ReviewQueueItem`.
 *
 * @param row           the RLS-scoped row (its in-scope existence is already
 *                      established by the read path / RLS — 005 SI-004).
 * @param canSeeProduct whether the CALLER has authority to see the row's
 *                      linked/created product. This helper does NOT compute
 *                      authority — the caller (controller) derives it from the
 *                      request context and passes the boolean. When `false`,
 *                      `resolved_product_id` is omitted from the output (the
 *                      row itself is still returned). FR-001a / data-model §2.2.
 *
 * Always omits `sale_context` (FR-007). Serializes `Date` fields to ISO-8601
 * strings to match the shipped `UnknownItem` wire shape.
 */
export function toReviewQueueItem(
  row: UnknownItemRow,
  canSeeProduct: boolean,
): ReviewQueueItem {
  const base = {
    id: row.id,
    tenant_id: row.tenantId,
    store_id: row.storeId,
    identifier_type: row.identifierType,
    identifier_value: row.identifierValue,
    source_system: row.sourceSystem,
    resolution_status: row.resolutionStatus,
    resolution_action: row.resolutionAction,
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolved_by: row.resolvedBy,
    encountered_at: row.encounteredAt.toISOString(),
  };

  // FR-001a: include the product reference ONLY when the caller may see it.
  // Conditional spread → the key is physically absent when suppressed (never
  // present-and-null, which would itself disclose that a product is linked).
  return canSeeProduct
    ? { ...base, resolved_product_id: row.resolvedProductId }
    : base;
}
