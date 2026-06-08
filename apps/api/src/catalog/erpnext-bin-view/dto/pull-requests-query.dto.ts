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
    since: z.string().uuid("since must be an opaque cursor").optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export type PullRequestsQuery = z.infer<typeof PullRequestsQuerySchema>;
