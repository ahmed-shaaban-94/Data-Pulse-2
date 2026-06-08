/**
 * pull-requests-query.dto.ts — Zod query schema for `binViewPullRequests`.
 *
 * Mirrors the 019 contract `Since` + `Limit` parameters:
 *   - `since`: optional opaque cursor (the prior page's last run id; a uuid string).
 *     Omitted = pull from the start. Treated as opaque; passed straight to the
 *     `> $1::uuid` comparison. A malformed value is a 400, never a silent from-start.
 *   - `limit`: optional integer 1..500, default 100.
 *
 * Scope (tenant) is NEVER read here — it comes from the connector principal
 * (§XII). `.strict()` rejects unknown query keys (mass-assignment ban).
 */
import { z } from "zod";

export const PullRequestsQuerySchema = z
  .object({
    // Opaque per the contract (minLength 1) — do NOT couple the DTO to the
    // cursor's internal shape (it is a run id today, but that is an impl detail).
    since: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type PullRequestsQuery = z.infer<typeof PullRequestsQuerySchema>;
