/**
 * outbox/retention.policy.ts — T590.
 *
 * Pure policy constants and cutoff math for the outbox retention sweep.
 *
 * This module is stateless and has no imports from NestJS, BullMQ, or any
 * database adapter. It carries ONLY the documented retention windows and
 * the per-window cutoff computation. Tests exercise these values directly.
 *
 * Retention policy (decided in docs/outbox/lifecycle.md section 5, FR-C-007)
 * ------------------------------------------------------------------------
 * Two windows apply to `outbox_events`, plus an audit-relevant carve-out:
 *
 *   - delivered non-audit       : 90 days (from processed_at)
 *   - failed | dead_lettered    : 365 days (from processed_at, falling back
 *                                  to updated_at when processed_at is null)
 *   - delivered audit.event.created : inherits the 365-day window even when
 *                                  delivered (FR-C-007 audit immutability).
 *                                  Same audit-relevant carve-out pinned by
 *                                  packages/db/__tests__/outbox/retention.spec.ts
 *                                  suite RT-2.5.
 *
 * Right-to-erasure (FR-C-004 / spec section 14.12) is handled out-of-band by
 * the erasure caller, which tombstones PII fields in the payload but leaves
 * the row's metadata in place. This processor is therefore unaware of
 * erasure: when a tombstoned row's timestamp crosses its window cutoff, the
 * row is purged like any other -- per the test contract pinned by
 * retention.spec.ts suite RT-4.
 *
 * Active rows (pending, claimed) are NEVER purged regardless of age.
 *
 * Batching
 * --------
 * The processor calls the repository with `BATCH_SIZE` rows per DELETE so
 * each transaction stays short and does not hold long locks against the
 * drainer's `FOR UPDATE SKIP LOCKED` claim path.
 */

/** Retention window for delivered non-audit events, in days. */
export const DELIVERED_RETENTION_DAYS = 90;

/**
 * Retention window for failed/dead_lettered rows AND for audit-relevant
 * (delivered `audit.event.created`) rows, in days. The audit carve-out is
 * spelled out in the policy doc and locked by retention.spec.ts RT-2.5.
 */
export const FAILED_RETENTION_DAYS = 365;

/** Rows processed per DELETE batch. Keeps individual transactions short. */
export const BATCH_SIZE = 1000;

/** Event type that triggers the 365-day audit-relevant carve-out. */
export const AUDIT_EVENT_TYPE = "audit.event.created";

/**
 * Compute the cutoff Date that is exactly `days` UTC days before `now`.
 *
 * The predicate against this cutoff is strict `<` (not `<=`), so a row
 * whose timestamp equals the cutoff is NOT yet eligible -- it crosses the
 * boundary on the next day's sweep. Mirrors `audit-retention.policy.ts`.
 *
 * @param now  The reference instant (typically the start of the sweep run).
 * @param days The window in days to subtract.
 * @returns    A new Date exactly `days` UTC days before `now`.
 */
export function computeCutoff(now: Date, days: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

/**
 * Convenience: compute both cutoffs for a single sweep run.
 *
 * Returned shape matches the repository's `purgeBatch` input so callers do
 * not need to know which window applies to which row class -- the
 * repository's SQL composes both predicates into a single DELETE.
 */
export interface RetentionCutoffs {
  /** Rows with processed_at < this date are eligible if delivered non-audit. */
  readonly deliveredCutoff: Date;
  /** Rows with processed_at < this date are eligible if failed/dead_lettered or delivered audit. */
  readonly failedCutoff: Date;
}

export function computeRetentionCutoffs(now: Date): RetentionCutoffs {
  return {
    deliveredCutoff: computeCutoff(now, DELIVERED_RETENTION_DAYS),
    failedCutoff: computeCutoff(now, FAILED_RETENTION_DAYS),
  };
}
