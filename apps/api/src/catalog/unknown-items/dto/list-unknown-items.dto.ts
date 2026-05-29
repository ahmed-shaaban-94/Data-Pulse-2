/**
 * list-unknown-items.dto.ts  (007 — T037)
 *
 * Zod schema for `tenantAdminListUnknownItems` query params. Extends the
 * shipped status/store_id/cursor/limit set with the 007 US2 params
 * (source_system filter, sort, optional group_by), mirroring the GATED
 * contract (packages/contracts/openapi/catalog/unknown-items.yaml,
 * operationId tenantAdminListUnknownItems):
 *
 *   - status        enum pending|resolved|dismissed (default pending)
 *   - store_id      uuid (optional residual narrow; RLS still governs)
 *   - cursor        opaque string (Wave 1 accepts but ignores)
 *   - limit         1..200, default 50 — out-of-range REJECTS (FR-005), no clamp
 *   - source_system string 1..64 (007 FR-002 filter)
 *   - sort          enum age_asc|age_desc|store (default age_desc; 007 FR-003)
 *   - group_by      enum store|source_system (optional; 007 FR-004 — ordering
 *                   only, the response stays the flat items array)
 *
 * `.strict()` rejects unknown params → 400 validation, so a typo or an
 * unsupported param never silently passes.
 */
import { z } from "zod";

export const ListUnknownItemsQuerySchema = z
  .object({
    status: z
      .enum(["pending", "resolved", "dismissed"])
      .optional()
      .default("pending"),
    store_id: z.string().uuid().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    source_system: z.string().min(1).max(64).optional(),
    sort: z.enum(["age_asc", "age_desc", "store"]).optional().default("age_desc"),
    group_by: z.enum(["store", "source_system"]).optional(),
  })
  .strict();

export type ListUnknownItemsQueryDto = z.infer<
  typeof ListUnknownItemsQuerySchema
>;

/** Sort options for the list path — whitelisted, never string-interpolated. */
export type ListSort = "age_asc" | "age_desc" | "store";
/** Grouping dimensions — whitelisted ordering prefixes. */
export type ListGroupBy = "store" | "source_system";
