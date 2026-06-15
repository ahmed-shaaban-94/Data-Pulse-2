/**
 * reconcile-decision.ts — 035 T032.
 *
 * The PURE remittance reconciliation decision (FR-014): given a claim's total
 * claimed amount and a remitted amount, compute variance (claimed − remitted)
 * and the outcome. No DB, no NestJS — the `ClaimService.reconcileRemittance` tx
 * drives the persisted write through this seam.
 *
 *   settled  — remitted === claimed (variance 0)
 *   partial  — remitted < claimed   (positive variance, balance remains)
 *   flagged  — remitted > claimed   (negative variance / over-remittance anomaly)
 *
 * MONEY (§III, no floats): integer ten-thousandths (scale 4), like
 * `apply-payment-decision`.
 */
const SCALE = 4;

function toScaledInt(money: string): bigint {
  const [whole = "0", frac = ""] = money.split(".");
  const fracPadded = (frac + "0".repeat(SCALE)).slice(0, SCALE);
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fracPadded || "0");
}

function fromScaledInt(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const unit = 10n ** BigInt(SCALE);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export type ReconcileOutcome = "settled" | "partial" | "flagged";

export interface ReconcileInput {
  readonly claimedAmount: string;
  readonly remittedAmount: string;
}

export interface ReconcileDecision {
  readonly outcome: ReconcileOutcome;
  readonly variance: string;
}

/** Decide a remittance reconciliation outcome + variance against a claim total. */
export function decideReconciliation(input: ReconcileInput): ReconcileDecision {
  const claimed = toScaledInt(input.claimedAmount);
  const remitted = toScaledInt(input.remittedAmount);
  const variance = claimed - remitted;

  let outcome: ReconcileOutcome;
  if (variance === 0n) {
    outcome = "settled";
  } else if (variance > 0n) {
    outcome = "partial";
  } else {
    outcome = "flagged";
  }
  return { outcome, variance: fromScaledInt(variance) };
}
