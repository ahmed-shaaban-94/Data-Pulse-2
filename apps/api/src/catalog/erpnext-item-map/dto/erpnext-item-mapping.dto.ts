/**
 * ErpnextItemMapping projection + `toErpnextItemMapping` (013-CRUD / T031).
 *
 * The `toBody()` projection of an `erpnext_item_map` row — the wire shape every
 * route returns (no raw DB entity, Constitution §IV). Mirrors the OpenAPI
 * `ErpnextItemMapping` schema
 * (packages/contracts/openapi/catalog/erpnext-item-map.yaml): identity +
 * lifecycle only — NO price, UOM, or store field (OQ-3/OQ-4 no-column).
 * snake_case keys per §IV.
 */

/** The service row shape (camelCase) the projection consumes. */
export interface ErpnextItemMapRow {
  readonly id: string;
  readonly tenantProductId: string;
  readonly erpnextItemRef: string;
  readonly state: "suggested" | "confirmed";
  readonly suggestionSource: "barcode" | "item_code" | "manual";
  readonly version: number;
  readonly suggestedBy: string | null;
  readonly suggestedAt: Date;
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The wire body (snake_case, §IV). */
export interface ErpnextItemMappingBody {
  readonly id: string;
  readonly tenant_product_id: string;
  readonly erpnext_item_ref: string;
  readonly state: "suggested" | "confirmed";
  readonly suggestion_source: "barcode" | "item_code" | "manual";
  readonly version: number;
  readonly suggested_by: string | null;
  readonly suggested_at: string;
  readonly confirmed_by: string | null;
  readonly confirmed_at: string | null;
  readonly retired_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString();

/** Project a service row to the §IV wire body. */
export function toErpnextItemMapping(
  row: ErpnextItemMapRow,
): ErpnextItemMappingBody {
  return {
    id: row.id,
    tenant_product_id: row.tenantProductId,
    erpnext_item_ref: row.erpnextItemRef,
    state: row.state,
    suggestion_source: row.suggestionSource,
    version: row.version,
    suggested_by: row.suggestedBy,
    suggested_at: row.suggestedAt.toISOString(),
    confirmed_by: row.confirmedBy,
    confirmed_at: iso(row.confirmedAt),
    retired_at: iso(row.retiredAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
