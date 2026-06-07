/**
 * sync-ops-query.dto.ts — Zod query schemas for the 025 read routes.
 *
 * Mirrors the 017 `list-backlog-query.dto` cursor-list convention:
 *   - `store_id`: optional in-scope store filter (uuid; within the session tenant).
 *   - `cursor`: optional opaque numeric pagination token (the last row's `sequence`
 *     for backlog, or an epoch/`started_at`-derived token for runs); unparseable →
 *     400, never a silent from-start.
 *   - `page_size`: optional integer 1..200, default 50 (the contract `PageSize`).
 *
 * Scope (tenant) is NEVER read here — it comes from the dashboard session
 * principal (§XII). `.strict()` rejects unknown query keys (mass-assignment ban),
 * so a smuggled `tenant_id` is a 400. The wire query param is snake_case
 * (`store_id`, `page_size`) per the contract; the DTO maps to camelCase.
 */
import { z } from "zod";

/** Summary route: only an optional store filter. */
export const SyncOpsSummaryQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
  })
  .strict();

export type SyncOpsSummaryQuery = z.infer<typeof SyncOpsSummaryQuerySchema>;

/** List routes (posting-backlog, reconciliation-runs): store filter + cursor + page. */
export const SyncOpsListQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    cursor: z
      .string()
      .min(1)
      // Bound to 18 digits — a PG bigint maxes at 19; capping at 18 keeps the
      // `> $cursor::bigint` comparison in range (a too-long cursor is a clean 400,
      // never an unhandled 22003 → 500). Mirrors the 017 backlog DTO.
      .max(18, "cursor exceeds the maximum length")
      .regex(/^[0-9]+$/, "cursor must be an opaque numeric token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type SyncOpsListQuery = z.infer<typeof SyncOpsListQuerySchema>;
