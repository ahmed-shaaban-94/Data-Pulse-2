/**
 * receivable-state-machine.ts — 035 T030.
 *
 * The NON-REVERSAL receivable lifecycle (035-DR-SETTLEMENT §OQ-4 CARVE). The
 * valid-state set + valid-transition set are encoded as pure, testable data so
 * later slices (T031 cash-application, T032 claim/remittance) drive transitions
 * through ONE checked seam rather than ad-hoc string comparisons.
 *
 * States (mirror the contract `ReceivableState` enum + the 0027
 * `receivable_state_valid` CHECK):
 *   open | partially_applied | settled | claimed | flagged
 *
 * `reversal_consumed` is INTENTIONALLY EXCLUDED — it lands in a later additive
 * bump after DP-026 closes (FR-024). Do NOT add it here.
 *
 * Transitions (contract §ReceivableState description, FR-005):
 *   open               → partially_applied | settled | claimed
 *   partially_applied  → settled | claimed | flagged
 *   claimed            → settled | partially_applied | flagged
 *   settled            → (terminal)
 *   flagged            → (terminal)
 *
 * This module is PURE: no NestJS, no DB, no I/O. T030 only OPENS receivables
 * (state 'open'); the transitions above are exercised by the later slices, but
 * are modelled now so the set is unit-testable and a single source of truth.
 */

/** The five non-reversal receivable lifecycle states. */
export const RECEIVABLE_STATES = [
  "open",
  "partially_applied",
  "settled",
  "claimed",
  "flagged",
] as const;

export type ReceivableState = (typeof RECEIVABLE_STATES)[number];

/** The state a freshly opened receivable starts in (T030). */
export const INITIAL_RECEIVABLE_STATE: ReceivableState = "open";

/**
 * The valid forward transitions, keyed by source state. A state mapping to an
 * empty set is terminal. Frozen so it cannot be mutated at runtime.
 */
const VALID_TRANSITIONS: Readonly<Record<ReceivableState, readonly ReceivableState[]>> =
  Object.freeze({
    open: ["partially_applied", "settled", "claimed"],
    partially_applied: ["settled", "claimed", "flagged"],
    claimed: ["settled", "partially_applied", "flagged"],
    settled: [],
    flagged: [],
  });

/** True iff `value` is one of the five valid receivable states. */
export function isReceivableState(value: string): value is ReceivableState {
  return (RECEIVABLE_STATES as readonly string[]).includes(value);
}

/**
 * True iff a receivable may move `from → to` under the non-reversal lifecycle.
 * A self-transition (`from === to`) is NOT valid (it is a no-op, not a
 * lifecycle move). Unknown states are never transitionable.
 */
export function canTransition(from: ReceivableState, to: ReceivableState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** True iff the state admits no further transitions (settled | flagged). */
export function isTerminalState(state: ReceivableState): boolean {
  return VALID_TRANSITIONS[state].length === 0;
}
