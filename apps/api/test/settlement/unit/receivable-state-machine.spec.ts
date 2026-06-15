/**
 * receivable-state-machine.spec.ts — 035 T030 (pure unit, no DB).
 *
 * Pins the non-reversal receivable lifecycle (§OQ-4 CARVE): the five valid
 * states, the valid-transition set, the deliberately-excluded
 * `reversal_consumed`, and the initial/terminal classification.
 */
import "reflect-metadata";

import {
  RECEIVABLE_STATES,
  INITIAL_RECEIVABLE_STATE,
  canTransition,
  isReceivableState,
  isTerminalState,
  type ReceivableState,
} from "../../../src/settlement/receivable-state-machine";

describe("035 T030 — receivable state set", () => {
  it("is exactly the five non-reversal states (no reversal_consumed)", () => {
    expect([...RECEIVABLE_STATES].sort()).toEqual(
      ["claimed", "flagged", "open", "partially_applied", "settled"].sort(),
    );
  });

  it("EXCLUDES reversal_consumed (§OQ-4 carve)", () => {
    expect(isReceivableState("reversal_consumed")).toBe(false);
    expect(RECEIVABLE_STATES as readonly string[]).not.toContain("reversal_consumed");
  });

  it("recognises every valid state and rejects junk", () => {
    for (const s of RECEIVABLE_STATES) expect(isReceivableState(s)).toBe(true);
    expect(isReceivableState("nonsense")).toBe(false);
    expect(isReceivableState("")).toBe(false);
  });

  it("opens new receivables in 'open'", () => {
    expect(INITIAL_RECEIVABLE_STATE).toBe("open");
  });
});

describe("035 T030 — valid transitions (FR-005)", () => {
  const VALID: ReadonlyArray<[ReceivableState, ReceivableState]> = [
    ["open", "partially_applied"],
    ["open", "settled"],
    ["open", "claimed"],
    ["partially_applied", "settled"],
    ["partially_applied", "claimed"],
    ["partially_applied", "flagged"],
    ["claimed", "settled"],
    ["claimed", "partially_applied"],
    ["claimed", "flagged"],
  ];

  it.each(VALID)("permits %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("forbids leaving a terminal state", () => {
    for (const term of ["settled", "flagged"] as const) {
      for (const to of RECEIVABLE_STATES) {
        expect(canTransition(term, to)).toBe(false);
      }
      expect(isTerminalState(term)).toBe(true);
    }
  });

  it("forbids a self-transition (a no-op is not a lifecycle move)", () => {
    for (const s of RECEIVABLE_STATES) expect(canTransition(s, s)).toBe(false);
  });

  it("forbids skipping back to 'open'", () => {
    for (const from of RECEIVABLE_STATES) {
      expect(canTransition(from, "open")).toBe(false);
    }
  });

  it("classifies open / partially_applied / claimed as non-terminal", () => {
    for (const s of ["open", "partially_applied", "claimed"] as const) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});
