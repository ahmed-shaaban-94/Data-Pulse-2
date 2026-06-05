/**
 * pull-postings-query.dto.ts — Zod query schema for `connectorPullPostings`.
 *
 * Mirrors the 012 contract `Since` + `Limit` parameters:
 *   - `since`: optional opaque cursor (string, minLength 1). Omitted/empty =
 *     pull from the start. 015 cursors are the monotonic row `sequence`; the
 *     value is parsed to a bigint for the > comparison (an unparseable cursor is
 *     a 400, NOT a silent from-start).
 *   - `limit`: optional integer 1..500, default 100.
 *
 * Scope (tenant) is NEVER read here — it comes from the connector principal
 * (§XII). `.strict()` rejects unknown query keys (FR-061-style mass-assignment ban).
 */
import { z } from "zod";

export const PullPostingsQuerySchema = z
  .object({
    since: z
      .string()
      .min(1)
      .regex(/^[0-9]+$/, "since must be an opaque numeric cursor")
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type PullPostingsQuery = z.infer<typeof PullPostingsQuerySchema>;
