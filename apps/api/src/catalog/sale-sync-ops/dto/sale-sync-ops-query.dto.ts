/**
 * sale-sync-ops-query.dto.ts — Zod query schemas for the 032 §9 read routes.
 *
 * Mirrors the 025 sync-ops-query convention. Scope (tenant) is NEVER read here
 * — it comes from the dashboard session principal (§XII). `.strict()` rejects
 * unknown query keys (mass-assignment ban), so a smuggled `tenant_id` is a 400.
 *
 * The NEEDS_REPAIR list cursor is the last page's last sale `id` (a UUIDv7) —
 * the keyset is `d.sale_id < $cursor` over the time-ordered id, newest-first.
 * A malformed cursor is a clean 400, never a silent from-start.
 */
import { z } from "zod";

// The cursor is the last page's last sale `id`, which is a UUIDv7 (time-ordered).
// Reject non-v7 cursors so a v1/v4 value can't drive an arbitrary page boundary —
// the version nibble must be `7` and the variant nibble must be 8/9/a/b.
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** NEEDS_REPAIR list: optional store filter + UUID keyset cursor + page size. */
export const NeedsRepairListQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    cursor: z
      .string()
      .min(1)
      .max(36, "cursor exceeds the maximum length")
      .regex(UUID_V7_RE, "cursor must be a UUIDv7 sale-reference token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type NeedsRepairListQuery = z.infer<typeof NeedsRepairListQuerySchema>;
