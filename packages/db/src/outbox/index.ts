/**
 * Barrel export for the outbox runtime module.
 *
 * Explicit named re-exports (no `export *`) so the public surface is
 * discoverable from a single read and accidental additions in the source
 * files don't silently leak into the package's public API.
 *
 *   T580 — producer helpers
 *   T560 — repository operations (claim / mark-delivered / mark-failed / mark-dead-lettered)
 */

// Producer (T580)
export {
  OUTBOX_EVENT_TYPES,
  emit,
  emitInNewTransaction,
} from "./producer";
export type {
  OutboxEventType,
  OutboxEmitInput,
} from "./producer";

// Repository (T560)
export {
  MAX_ATTEMPTS,
  OutboxStateTransitionError,
  claimBatch,
  markDeadLettered,
  markDelivered,
  markFailed,
  nextAttemptDelayMs,
} from "./repository";
export type {
  ClaimedOutboxEvent,
  ClaimFn,
} from "./repository";
