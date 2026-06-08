/**
 * connector-health.liveness.ts — 020-FND (T007).
 *
 * Pure liveness-verdict derivation for the connector health read-model. The
 * verdict is NEVER persisted — it is recomputed on every operator read against
 * the current server clock (data-model.md "Derived value"), which is why 020 v1
 * needs no scheduled stale-sweep (§V deferral).
 *
 * Precedence (data-model.md):
 *   1. disabled_at IS NOT NULL          -> "disabled"   (wins over all liveness)
 *   2. last_seen_at IS NULL             -> "never_seen"
 *   3. now - last_seen_at <= threshold  -> "healthy"
 *   4. else                             -> "stale"
 *
 * No DB, no DI, no ambient clock — `now` and `thresholdMs` are injected so the
 * function is deterministic and unit-testable. §X: `last_seen_at` is the DP2
 * server clock; the connector-reported clock is never an input here.
 */

/** The four liveness verdicts (closed set). */
export type LivenessVerdict = "healthy" | "stale" | "never_seen" | "disabled";

/** Default staleness threshold: 5 minutes (FR-002). */
export const DEFAULT_STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Derive the liveness verdict for one connector instance.
 *
 * @param lastSeenAt  server-clock time of the last accepted heartbeat, or null
 * @param now         current server clock (injected for determinism)
 * @param thresholdMs staleness threshold in milliseconds (default 5 min)
 * @param disabledAt  the 018 registration's `disabled_at`, or null if active
 */
export function deriveLiveness(
  lastSeenAt: Date | null,
  now: Date,
  thresholdMs: number,
  disabledAt: Date | null,
): LivenessVerdict {
  if (disabledAt !== null) return "disabled";
  if (lastSeenAt === null) return "never_seen";
  const elapsedMs = now.getTime() - lastSeenAt.getTime();
  return elapsedMs <= thresholdMs ? "healthy" : "stale";
}

/**
 * Seconds elapsed since the last heartbeat (integer, floored), or null when
 * never seen. Surfaced as `secondsSinceLastSeen` in the wire projection (FR-001).
 */
export function secondsSinceLastSeen(lastSeenAt: Date | null, now: Date): number | null {
  if (lastSeenAt === null) return null;
  return Math.floor((now.getTime() - lastSeenAt.getTime()) / 1000);
}
