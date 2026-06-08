/**
 * 021 product-master reconciliation — Zod request DTOs.
 *
 * Scope (tenant) + actor are NEVER read from the body — they come from the
 * dashboard session principal (§XII). `.strict()` rejects unknown keys
 * (mass-assignment ban). Mirrors the 017 / 013 DTO conventions.
 */
import { z } from "zod";

const PRODUCT_MISMATCH_CLASSES = [
  "match",
  "unmapped_dp2_product",
  "suggestion_unconfirmed",
  "unmapped_erpnext_item",
  "attribute_drift",
  "sellable_state_divergence",
] as const;

/** Backlog list + run-results list query (cursor / limit / class). */
export const ListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    class: z.enum(PRODUCT_MISMATCH_CLASSES).optional(),
  })
  .strict();

export type ListQuery = z.infer<typeof ListQuerySchema>;

/** Run list query (cursor / limit only — no class). */
export const ListRunsQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

/**
 * Repair request (US2). Drives 013's lifecycle (FR-010). `tenant_id` + actor are
 * server-resolved (§XII). The optional fields are validated per repairKind in the
 * service (a `confirm`/`re_point` needs `mappingId` + `version`; a
 * `suggest_confirm` needs `erpnextItemRef`).
 */
export const RepairProductMappingBodySchema = z
  .object({
    repairKind: z.enum(["confirm", "suggest_confirm", "re_point"]),
    tenantProductId: z.string().uuid(),
    mappingId: z.string().uuid().optional(),
    erpnextItemRef: z.string().min(1).max(180).optional(),
    version: z.coerce.number().int().min(1).optional(),
    // OPTIONAL: when present, the repair targets a persisted US3 result — the
    // result_state transitions open→repaired on a `mapped` outcome (drives the
    // same 013 lifecycle). Both must be supplied together (validated server-side).
    runId: z.string().uuid().optional(),
    resultId: z.string().uuid().optional(),
  })
  .strict();

export type RepairProductMappingBody = z.infer<typeof RepairProductMappingBodySchema>;

/** Trigger-run request (US3). v1 carries no body field. */
export const TriggerProductRunBodySchema = z.object({}).strict();

export type TriggerProductRunBody = z.infer<typeof TriggerProductRunBodySchema>;
