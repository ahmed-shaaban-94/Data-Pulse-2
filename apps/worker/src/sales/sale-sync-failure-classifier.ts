/**
 * Sale-sync dead-letter CLASSIFIER — 032 §8 / T029.
 *
 * The pure mapping from a §8 refusal condition to the §8 dead-letter routing
 * (Spec-029 §6 RETRYABLE vs NEEDS_REPAIR) + the server-authoritative
 * `sales.sync_status` failure state it advances to. NO DB access, NO HTTP, NO
 * side effects — a `(condition) -> classification` function the quarantine
 * producer (T030) consumes.
 *
 * WHY this is a standalone unit (and where the "failure" comes from)
 * -----------------------------------------------------------------
 * DP-2 is the contract/orchestration boundary (POS -> DP-2 -> Connector ->
 * ERPNext). DP-2's own sale-processing drain makes NO outbound posting call —
 * crossing that wire would violate the architecture invariant. So there is no
 * live 401/403/5xx HTTP sync inside this worker to "feed" the classifier; the
 * classifier is the decision table a future sync-attempt surface (or the
 * processor's failure branch) calls with an ALREADY-OBSERVED condition. This
 * keeps T029 directly testable and decoupled from any upstream transport.
 *
 * VOCABULARY — worker-local copy, PINNED to §7/§8 (not imported)
 * -------------------------------------------------------------
 * The four `sync_status` values + the two `classification` strings are owned by
 * spec §7/§8 and enforced by the `0026_sale_sync_status.sql` CHECK constraints
 * (`sales_sync_status_valid` / `sale_sync_deadletters_classification_valid`).
 * The API side's `apps/api/src/catalog/sales/sale-sync-status.ts` is the source
 * of truth, but the worker MUST NOT import from `apps/api` (apps must not
 * depend on each other — the established `AUDIT_QUEUE_NAME` precedent in
 * `audit.worker.ts`). So this module keeps a worker-LOCAL copy of the literals
 * and a `sale-sync-failure-classifier.spec.ts` test PINS them to the spec
 * values, the same way `audit.worker.spec.ts` pins the queue-name literal. Do
 * NOT "fix" this into a cross-app import.
 *
 * AUTH BOUND TO 028 (G10) — NOT re-decided here
 * ---------------------------------------------
 * The 401/403 rows of the §8 table are 028-owned (G10). This classifier records
 * the condition's classification AND flags it `authOwnedBy028: true` so the
 * producer and operators know the auth semantics are bound by reference, not
 * decided here. Specifically:
 *   - 401 (auth invalid)        -> RETRYABLE (re-auth). 028 (ref).
 *   - 403 (forbidden)           -> the §8 table reads "RETRYABLE -> NEEDS_REPAIR
 *                                  if persistent". The persistence escalation is
 *                                  028 OQ-5 (OPEN, 028-owned). We DO NOT
 *                                  implement a persistence tracker here —
 *                                  encoding the "if persistent" rule would be
 *                                  re-deciding auth (G10 violation). We classify
 *                                  403 as RETRYABLE and mark it
 *                                  `oq5Escalation: true` so the OQ-5 owner path
 *                                  (when decided) can route it; the reconnect-
 *                                  auth-failure case maps here too.
 *
 * REDACTION (Principle XIII/XIV)
 * ------------------------------
 * `reasonCode` is a REDACTED machine label from a closed set — NEVER a raw
 * upstream error body. The label is what the `sale_sync_deadletters.reason_code`
 * column stores and what the Console surface shows.
 */

/**
 * Worker-local copy of the §7 server-authoritative sale-status FAILURE values,
 * pinned to the `0026` CHECK constraint by `sale-sync-failure-classifier.spec`.
 */
export const SYNC_STATUS_FAILED_RETRYABLE = "failed-retryable" as const;
export const SYNC_STATUS_FAILED_NEEDS_REPAIR = "failed-needs-repair" as const;

export type SaleSyncFailureStatus =
  | typeof SYNC_STATUS_FAILED_RETRYABLE
  | typeof SYNC_STATUS_FAILED_NEEDS_REPAIR;

/** Worker-local copy of the §8 dead-letter classification vocabulary. */
export type DeadLetterClassification = "retryable" | "needs-repair";

/**
 * The §7->§8 mapping: a `failed-retryable` status is "retryable"; a
 * `failed-needs-repair` status is "needs-repair". Mirrors the API side's
 * `classificationForStatus` for the two failure states (the worker-local twin).
 */
function classificationForFailureStatus(
  status: SaleSyncFailureStatus,
): DeadLetterClassification {
  return status === SYNC_STATUS_FAILED_NEEDS_REPAIR
    ? "needs-repair"
    : "retryable";
}

/**
 * The enumerated §8 refusal conditions a sync attempt can hit. This is the
 * CLOSED input domain of the classifier — a caller maps its observed failure
 * (an HTTP status, a thrown error class, a transport timeout) to ONE of these
 * before classifying. Adding a condition is a deliberate taxonomy change.
 *
 * Mirrors the §8 table rows that have a dead-letter classification (the 409
 * request-level rows — idempotency-key conflict, provenance reuse, already-
 * applied — are NOT here: they are request-level outcomes, never a sync
 * dead-letter, and the live provenance 409 (F-3) is untouched).
 */
export const SYNC_FAILURE_CONDITION = {
  /** 401 — auth invalid. RETRYABLE (re-auth). 028 (ref). */
  AUTH_INVALID: "auth_invalid",
  /**
   * 403 — forbidden (revoked / out-of-scope). RETRYABLE; the persistent ->
   * NEEDS_REPAIR escalation is 028 OQ-5 (OPEN, not decided here).
   */
  FORBIDDEN: "forbidden",
  /**
   * A reconnect-auth-failure on a sync attempt. §8: "routes to 028 OQ-5
   * classification". Treated identically to FORBIDDEN here (RETRYABLE +
   * OQ-5-flagged), pending the 028 OQ-5 owner decision.
   */
  RECONNECT_AUTH_FAILURE: "reconnect_auth_failure",
  /** Validation failure (422/400). NEEDS_REPAIR. DP-2-owned. */
  VALIDATION_FAILURE: "validation_failure",
  /** Transient (network / 5xx). RETRYABLE (backoff). DP-2-owned. */
  TRANSIENT: "transient",
} as const;

export type SyncFailureCondition =
  (typeof SYNC_FAILURE_CONDITION)[keyof typeof SYNC_FAILURE_CONDITION];

/**
 * The result of classifying a §8 condition.
 *
 * `classification` + `syncStatus` come straight from the §7/§8 vocabulary.
 * `reasonCode` is a redacted machine label. `authOwnedBy028` / `oq5Escalation`
 * are the G10 binding markers — they let the producer + Console show that auth
 * refusal semantics are bound to 028 by reference and (for 403/reconnect) that
 * the persistence escalation is the OPEN 028 OQ-5 owner path, NOT a decision
 * made here.
 */
export interface SyncFailureClassification {
  readonly classification: DeadLetterClassification;
  readonly syncStatus: SaleSyncFailureStatus;
  readonly reasonCode: string;
  /** True when the auth refusal semantics are 028-owned (bound by reference). */
  readonly authOwnedBy028: boolean;
  /**
   * True only for the 403 / reconnect-auth cases whose persistent ->
   * NEEDS_REPAIR escalation is the OPEN 028 OQ-5 owner decision. Never acted on
   * here (no persistence tracker — that would re-decide auth, G10).
   */
  readonly oq5Escalation: boolean;
}

/** Internal static table — the §8 mapping, one entry per condition. */
const TABLE: Readonly<
  Record<SyncFailureCondition, Omit<SyncFailureClassification, "classification">>
> = {
  [SYNC_FAILURE_CONDITION.AUTH_INVALID]: {
    syncStatus: SYNC_STATUS_FAILED_RETRYABLE,
    reasonCode: "auth_invalid",
    authOwnedBy028: true,
    oq5Escalation: false,
  },
  [SYNC_FAILURE_CONDITION.FORBIDDEN]: {
    syncStatus: SYNC_STATUS_FAILED_RETRYABLE,
    reasonCode: "forbidden",
    authOwnedBy028: true,
    oq5Escalation: true,
  },
  [SYNC_FAILURE_CONDITION.RECONNECT_AUTH_FAILURE]: {
    syncStatus: SYNC_STATUS_FAILED_RETRYABLE,
    reasonCode: "reconnect_auth_failure",
    authOwnedBy028: true,
    oq5Escalation: true,
  },
  [SYNC_FAILURE_CONDITION.VALIDATION_FAILURE]: {
    syncStatus: SYNC_STATUS_FAILED_NEEDS_REPAIR,
    reasonCode: "validation_failure",
    authOwnedBy028: false,
    oq5Escalation: false,
  },
  [SYNC_FAILURE_CONDITION.TRANSIENT]: {
    syncStatus: SYNC_STATUS_FAILED_RETRYABLE,
    reasonCode: "transient_5xx",
    authOwnedBy028: false,
    oq5Escalation: false,
  },
};

/**
 * Classify a §8 refusal condition into the dead-letter routing + the
 * server-authoritative `sync_status` failure state. Pure; deterministic.
 *
 * The `classification` is DERIVED from the `syncStatus` via
 * `classificationForFailureStatus` (the single mapping point), so the two can
 * never drift: a `failed-retryable` status is always "retryable", a
 * `failed-needs-repair` status is always "needs-repair".
 */
export function classifySyncFailure(
  condition: SyncFailureCondition,
): SyncFailureClassification {
  const entry = TABLE[condition];
  return {
    classification: classificationForFailureStatus(entry.syncStatus),
    ...entry,
  };
}
