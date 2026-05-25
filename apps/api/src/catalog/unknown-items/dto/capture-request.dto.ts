/**
 * PosCaptureItemRequest DTO — 005 Wave 1 / T520 (VALIDATION).
 *
 * Boundary Zod schema for `POST /api/pos/v1/catalog/unknown-items`.
 * Mirrors the OpenAPI `PosCaptureItemRequest` shape from
 * `packages/contracts/openapi/catalog/unknown-items.yaml` AND the three
 * `unknown_items` CHK constraints in `packages/db/drizzle/0007_catalog.sql`:
 *
 *   - `unknown_items_identifier_type_valid` (line 406)
 *     identifier_type IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')
 *
 *   - `unknown_items_value_length` (line 408)
 *     length(value) BETWEEN 1 AND 200
 *
 *   - `unknown_items_source_system_required` (line 427)
 *     (identifier_type = 'external_pos_id' AND source_system IS NOT NULL)
 *     OR (identifier_type <> 'external_pos_id' AND source_system IS NULL)
 *
 * The CHK is bidirectional: `barcode`/`sku`/`plu`/`supplier_code` MUST NOT
 * carry a `source_system` (NULL only). A naive "external_pos_id requires
 * source_system" refine would silently pass `{type:"barcode", source_system:"X"}`
 * and only fail at the DB INSERT (500). The `.superRefine` below enforces
 * both arms with `path:["source_system"]` so ZodError surfaces them at
 * the boundary, never at the DB.
 *
 * Spec anchors:
 *   - FR-070 — missing-required-field rejection without side-effects
 *   - FR-071 — malformed-value rejection (length, type, cross-field)
 *   - FR-072 — deterministic failure outcome; raw identifier values
 *              MUST NOT appear in observability streams. ZodIssue's
 *              `received` field is a type tag (e.g. "number") for
 *              `invalid_type` and absent for `too_small`/`too_big`/
 *              `invalid_enum_value`/`custom` — so submitted values do
 *              not flow into the error envelope's `details` array.
 *              Enforced empirically by the spec's sentinel assertion.
 */
import { z } from "zod";

const IDENTIFIER_TYPES = [
  "barcode",
  "sku",
  "plu",
  "supplier_code",
  "external_pos_id",
] as const;

export const PosCaptureItemRequestSchema = z
  .object({
    identifier_type: z.enum(IDENTIFIER_TYPES),
    identifier_value: z.string().min(1).max(200),
    source_system: z.string().min(1).max(64).nullable().optional(),
    sale_context: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Mirrors `unknown_items_source_system_required` CHK (0007_catalog.sql:427).
    const hasSourceSystem =
      data.source_system !== undefined && data.source_system !== null;
    if (data.identifier_type === "external_pos_id" && !hasSourceSystem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_system"],
        message:
          "source_system is required when identifier_type is 'external_pos_id'",
      });
      return;
    }
    if (data.identifier_type !== "external_pos_id" && hasSourceSystem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_system"],
        message:
          "source_system must be omitted (null) unless identifier_type is 'external_pos_id'",
      });
    }
  });

export type PosCaptureItemRequestDto = z.infer<
  typeof PosCaptureItemRequestSchema
>;
