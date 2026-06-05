/**
 * SetErpnextWarehouseMappingRequest DTO + Zod schema (014-CRUD / T030, T034).
 *
 * Mirrors the OpenAPI `SetErpnextWarehouseMappingRequest`
 * (packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml):
 *   required: [store_id, erpnext_warehouse_ref]
 *   additionalProperties: false
 *
 * STRICT (`.strict()`) — Constitution §XII mass-assignment ban. `tenant_id`,
 * `purpose`, `version`, `set_by` are all server-resolved and MUST NOT appear in
 * the body; a smuggled key is rejected 400 `validation_error`. v1 has no
 * `purpose` field — the service always records `'stock'` (OQ-2; the `returns`
 * purpose is a future widening).
 */
import { z } from "zod";

export const SetErpnextWarehouseMappingRequestSchema = z
  .object({
    store_id: z.string().uuid(),
    erpnext_warehouse_ref: z.string().min(1).max(180),
  })
  .strict();

export type SetErpnextWarehouseMappingRequestDto = z.infer<
  typeof SetErpnextWarehouseMappingRequestSchema
>;
