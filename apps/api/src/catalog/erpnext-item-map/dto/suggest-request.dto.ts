/**
 * SuggestErpnextItemMappingRequest DTO + Zod schema (013-CRUD / T030, T035).
 *
 * Mirrors the OpenAPI `SuggestErpnextItemMappingRequest`
 * (packages/contracts/openapi/catalog/erpnext-item-map.yaml):
 *   required: [tenant_product_id, erpnext_item_ref]
 *   additionalProperties: false
 *
 * STRICT (`.strict()`) — Constitution §XII mass-assignment ban. `tenant_id`,
 * `state`, `version`, `suggested_by`/`confirmed_by`, `suggestion_source` are all
 * server-resolved and MUST NOT appear in the body; a smuggled key is rejected
 * 400 `validation_error`. v1 has no `suggestion_source` field — the service
 * always records `'manual'` (finding AUTO_MATCH_NO_SOURCE: no ERPNext
 * item-search op exists in 012, and OQ-8 forbids an import worker).
 */
import { z } from "zod";

export const SuggestErpnextItemMappingRequestSchema = z
  .object({
    tenant_product_id: z.string().uuid(),
    erpnext_item_ref: z.string().min(1).max(140),
  })
  .strict();

export type SuggestErpnextItemMappingRequestDto = z.infer<
  typeof SuggestErpnextItemMappingRequestSchema
>;
