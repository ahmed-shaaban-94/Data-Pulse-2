/**
 * Sale sync-status vocabulary + transitions — 032 §7 (T005).
 *
 * The server-authoritative sale-status DP-2 owns. POS NEVER overrides it (the
 * terminal observes, DP-2 decides — §7). The persisted column is
 * `sales.sync_status` (migration 0025), constrained by the
 * `sales_sync_status_valid` CHECK to exactly these values. This module is the
 * single source of truth for the vocabulary, the allowed transitions, and the
 * Spec-029 §6 terminal-visible mapping the Console reads.
 *
 * No DB access here — this is a pure value/transition module consumed by the
 * capture write path, the off-request drain, and the dead-letter classifier.
 *
 * Temporal note (Principle X): transitions are stamped on the SERVER clock by
 * the writers (the capture INSERT default, the drain `now()`); this module does
 * not stamp time — it only defines the legal value set + transitions.
 */

/** The four server-authoritative sale-status values (§7). */
export const SALE_SYNC_STATUS = {
  /** Persisted at capture, in the capture transaction. */
  CAPTURED: "captured",
  /** Set by the off-request sale-processing drain (the same UPDATE that sets processed_at). */
  SYNCED: "synced",
  /** Set by the §8 dead-letter classifier for a transient failure (backoff). */
  FAILED_RETRYABLE: "failed-retryable",
  /** Set by the §8 dead-letter classifier for a non-retryable failure (operator repair). */
  FAILED_NEEDS_REPAIR: "failed-needs-repair",
} as const;

export type SaleSyncStatus =
  (typeof SALE_SYNC_STATUS)[keyof typeof SALE_SYNC_STATUS];

/** All legal values (matches the 0025 CHECK constraint exactly). */
export const SALE_SYNC_STATUS_VALUES: ReadonlyArray<SaleSyncStatus> = [
  SALE_SYNC_STATUS.CAPTURED,
  SALE_SYNC_STATUS.SYNCED,
  SALE_SYNC_STATUS.FAILED_RETRYABLE,
  SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR,
];

/**
 * Allowed transitions (§7). Keyed by the FROM state; the value is the set of
 * legal TO states. A retryable failure may recover to `synced` on a later drain
 * or escalate to `needs-repair`; a `needs-repair` item is only ever moved by a
 * server-mediated repair (§9) which re-queues it (→ `captured`-equivalent
 * re-drain, modeled here as a transition back to a retry-eligible state).
 *
 * This is the AUTHORITATIVE transition table; writers MUST NOT move a status
 * outside it. `synced` is terminal-success (no outbound transition except a
 * repair-initiated re-drain is never needed once synced).
 */
export const SALE_SYNC_STATUS_TRANSITIONS: Readonly<
  Record<SaleSyncStatus, ReadonlyArray<SaleSyncStatus>>
> = {
  [SALE_SYNC_STATUS.CAPTURED]: [
    SALE_SYNC_STATUS.SYNCED,
    SALE_SYNC_STATUS.FAILED_RETRYABLE,
    SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR,
  ],
  [SALE_SYNC_STATUS.FAILED_RETRYABLE]: [
    SALE_SYNC_STATUS.SYNCED,
    SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR,
  ],
  // A repair (§9) re-queues a needs-repair item; the re-drain may then resolve
  // it to synced or re-fail. The repair itself moves it to failed-retryable
  // (re-eligible), never directly to synced (no sale-fact rewrite, no shortcut).
  [SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR]: [SALE_SYNC_STATUS.FAILED_RETRYABLE],
  // Terminal success — no outbound transition.
  [SALE_SYNC_STATUS.SYNCED]: [],
};

/** True if `to` is a legal next state from `from`. */
export function isAllowedSaleSyncTransition(
  from: SaleSyncStatus,
  to: SaleSyncStatus,
): boolean {
  return SALE_SYNC_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Spec-029 §6 terminal-visible mapping. The Console reads the DP-2 status; the
 * POS terminal sees a coarser outbox-UX state. This maps the server status to
 * the Spec-029 §6 RETRYABLE / NEEDS_REPAIR dead-letter classification used by
 * the §8 taxonomy.
 *
 *   captured / synced     → not a failure (no dead-letter classification)
 *   failed-retryable      → RETRYABLE (backoff)
 *   failed-needs-repair   → NEEDS_REPAIR (operator-mediated)
 */
export type DeadLetterClassification = "retryable" | "needs-repair";

export function classificationForStatus(
  status: SaleSyncStatus,
): DeadLetterClassification | null {
  switch (status) {
    case SALE_SYNC_STATUS.FAILED_RETRYABLE:
      return "retryable";
    case SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR:
      return "needs-repair";
    default:
      return null;
  }
}
