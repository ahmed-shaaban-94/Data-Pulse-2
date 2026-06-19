/**
 * apply-payment-decision.spec.ts — 035 T031 (RED-first).
 *
 * Unit tests for the PURE cash-application decision: given a receivable's
 * current outstanding balance + state and an applied amount, compute the new
 * balance + new state, or reject (over-application). Exact-decimal money
 * (no floats, §III). No DB, no NestJS.
 */
import {
  decideApplication,
  fromScaledInt,
  toScaledInt,
  type ApplyDecision,
} from "../../../src/settlement/apply-payment-decision";

describe("decideApplication — 035 T031 cash-application decision", () => {
  it("partial application reduces the balance and moves open → partially_applied", () => {
    const d = decideApplication({ outstandingBalance: "120.0000", amount: "50.0000" });
    expect(d.kind).toBe("ok");
    const ok = d as Extract<ApplyDecision, { kind: "ok" }>;
    expect(ok.newBalance).toBe("70.0000");
    expect(ok.newState).toBe("partially_applied");
  });

  it("clearing application zeroes the balance and moves to settled", () => {
    const d = decideApplication({ outstandingBalance: "120.0000", amount: "120.0000" });
    expect(d.kind).toBe("ok");
    const ok = d as Extract<ApplyDecision, { kind: "ok" }>;
    expect(ok.newBalance).toBe("0.0000");
    expect(ok.newState).toBe("settled");
  });

  it("over-application (amount > balance) is rejected, no truncation", () => {
    const d = decideApplication({ outstandingBalance: "100.0000", amount: "100.0001" });
    expect(d.kind).toBe("over_application");
  });

  it("handles sub-unit precision exactly (no float drift)", () => {
    const d = decideApplication({ outstandingBalance: "0.3000", amount: "0.1000" });
    expect(d.kind).toBe("ok");
    const ok = d as Extract<ApplyDecision, { kind: "ok" }>;
    expect(ok.newBalance).toBe("0.2000");
    expect(ok.newState).toBe("partially_applied");
  });

  it("a partial application against an already partially_applied receivable stays partially_applied", () => {
    const d = decideApplication({
      outstandingBalance: "70.0000",
      amount: "20.0000",
      currentState: "partially_applied",
    });
    expect(d.kind).toBe("ok");
    expect((d as Extract<ApplyDecision, { kind: "ok" }>).newState).toBe("partially_applied");
  });

  it("a clearing application against a partially_applied receivable settles it", () => {
    const d = decideApplication({
      outstandingBalance: "70.0000",
      amount: "70.0000",
      currentState: "partially_applied",
    });
    expect((d as Extract<ApplyDecision, { kind: "ok" }>).newState).toBe("settled");
  });
});

describe("toScaledInt — exact-decimal money → ten-thousandths (audit C-1)", () => {
  // Regression guard: positive values must keep their pre-fix behaviour exactly.
  it("scales a positive whole-and-fraction value", () => {
    expect(toScaledInt("1.5000")).toBe(15000n);
  });

  it("scales a positive whole-only value", () => {
    expect(toScaledInt("12")).toBe(120000n);
  });

  // The bug: a negative whole part added the fraction positively → wrong magnitude.
  it("scales a negative whole-and-fraction value with the sign on the WHOLE magnitude", () => {
    expect(toScaledInt("-1.5000")).toBe(-15000n);
  });

  it("scales a negative sub-cent value (sign applied to the fraction too)", () => {
    expect(toScaledInt("-0.0001")).toBe(-1n);
  });

  it("round-trips with fromScaledInt across the sign boundary", () => {
    for (const m of ["1.5000", "-1.5000", "0.0000", "-0.0001", "123.4567", "-123.4567"]) {
      expect(fromScaledInt(toScaledInt(m))).toBe(m);
    }
  });
});
