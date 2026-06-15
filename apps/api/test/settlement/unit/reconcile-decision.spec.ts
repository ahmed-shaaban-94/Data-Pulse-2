/**
 * reconcile-decision.spec.ts — 035 T032 (RED-first).
 *
 * Unit tests for the PURE remittance reconciliation decision: given a claim's
 * total claimed amount and a remitted amount, compute variance (claimed −
 * remitted) and the outcome (settled | partial | flagged). Exact-decimal money,
 * no floats (§III). No DB, no NestJS.
 */
import {
  decideReconciliation,
  type ReconcileDecision,
} from "../../../src/settlement/reconcile-decision";

describe("decideReconciliation — 035 T032 remittance reconciliation", () => {
  it("full remittance (remitted === claimed) → settled, variance 0", () => {
    const d = decideReconciliation({ claimedAmount: "120.0000", remittedAmount: "120.0000" });
    expect(d.outcome).toBe("settled");
    expect(d.variance).toBe("0.0000");
  });

  it("partial remittance (remitted < claimed) → partial, positive variance", () => {
    const d = decideReconciliation({ claimedAmount: "120.0000", remittedAmount: "90.0000" });
    expect(d.outcome).toBe("partial");
    expect(d.variance).toBe("30.0000");
  });

  it("over-remittance (remitted > claimed) → flagged, negative variance", () => {
    const d = decideReconciliation({ claimedAmount: "100.0000", remittedAmount: "130.0000" });
    expect(d.outcome).toBe("flagged");
    expect(d.variance).toBe("-30.0000");
  });

  it("zero remittance → partial, full variance (nothing paid yet)", () => {
    const d = decideReconciliation({ claimedAmount: "50.0000", remittedAmount: "0.0000" });
    expect(d.outcome).toBe("partial");
    expect(d.variance).toBe("50.0000");
  });

  it("sub-unit precision is exact (no float drift)", () => {
    const d = decideReconciliation({ claimedAmount: "0.3000", remittedAmount: "0.1000" });
    expect(d.variance).toBe("0.2000");
    expect(d.outcome).toBe("partial");
  });

  it("exposes the decision shape", () => {
    const d: ReconcileDecision = decideReconciliation({
      claimedAmount: "1.0000",
      remittedAmount: "1.0000",
    });
    expect(d).toEqual({ outcome: "settled", variance: "0.0000" });
  });
});
