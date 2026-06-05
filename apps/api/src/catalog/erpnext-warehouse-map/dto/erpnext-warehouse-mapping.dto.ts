/**
 * ErpnextWarehouseMapping projection + `toErpnextWarehouseMapping` (014-CRUD / T031).
 *
 * The `toBody()` projection of an `erpnext_warehouse_map` row — the wire shape
 * every route returns (no raw DB entity, Constitution §IV). Mirrors the OpenAPI
 * `ErpnextWarehouseMapping` schema
 * (packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml): identity +
 * lifecycle only — NO Bin-quantity, valuation, cost, or on-hand field (OQ-1;
 * the rejected read-down look-alike). snake_case keys per §IV.
 */

/** The service row shape (camelCase) the projection consumes. */
export interface ErpnextWarehouseMapRow {
  readonly id: string;
  readonly storeId: string;
  readonly purpose: "stock" | "returns";
  readonly erpnextWarehouseRef: string;
  readonly version: number;
  readonly setBy: string | null;
  readonly setAt: Date;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The wire body (snake_case, §IV). */
export interface ErpnextWarehouseMappingBody {
  readonly id: string;
  readonly store_id: string;
  readonly purpose: "stock" | "returns";
  readonly erpnext_warehouse_ref: string;
  readonly version: number;
  readonly set_by: string | null;
  readonly set_at: string;
  readonly retired_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString();

/** Project a service row to the §IV wire body. */
export function toErpnextWarehouseMapping(
  row: ErpnextWarehouseMapRow,
): ErpnextWarehouseMappingBody {
  return {
    id: row.id,
    store_id: row.storeId,
    purpose: row.purpose,
    erpnext_warehouse_ref: row.erpnextWarehouseRef,
    version: row.version,
    set_by: row.setBy,
    set_at: row.setAt.toISOString(),
    retired_at: iso(row.retiredAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
