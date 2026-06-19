/**
 * apply-payment-decision.ts — 035 T031.
 *
 * The PURE cash-application decision (7-C): given a receivable's outstanding
 * balance (+ optional current state) and an applied amount, compute the new
 * balance + the resulting lifecycle state, or reject as over-application. No DB,
 * no NestJS — the `ReceivableService.applyPayment` tx drives the persisted write
 * through this single seam (mirrors `receivable-state-machine.ts`).
 *
 * MONEY (§III, no floats): amounts are exact-decimal strings with up to 4
 * fractional digits (DB `numeric(19,4)`). We compare/subtract in integer
 * "ten-thousandths" (scale 4) to avoid binary-float drift, then re-render.
 */
import type { ReceivableState } from "./receivable-state-machine";

const SCALE = 4;

/**
 * Parse an exact-decimal money string into integer ten-thousandths (bigint).
 *
 * The sign is applied to the WHOLE magnitude, not just the integer part: for
 * `"-1.5000"` the fractional `5000` must subtract from the magnitude, not add
 * to it. Splitting `"-1.5000"` yields `whole="-1"`, so `BigInt(whole)*unit +
 * frac` would give `-10000 + 5000 = -5000` (wrong; correct is `-15000`). We
 * therefore strip the sign, build the magnitude, then re-apply — mirroring
 * `fromScaledInt`'s sign handling so the two are exact round-trip inverses.
 * (Latent today: `decideApplication` rejects `amount > balance` before any
 * negative reaches here, but the DP-026 reversal/credit-note path will.)
 */
export function toScaledInt(money: string): bigint {
  const negative = money.startsWith("-");
  const abs = negative ? money.slice(1) : money;
  const [whole = "0", frac = ""] = abs.split(".");
  const fracPadded = (frac + "0".repeat(SCALE)).slice(0, SCALE);
  const magnitude = BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fracPadded || "0");
  return negative ? -magnitude : magnitude;
}

/** Render integer ten-thousandths back to a fixed scale-4 money string. */
export function fromScaledInt(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const unit = 10n ** BigInt(SCALE);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export interface ApplyInput {
  readonly outstandingBalance: string;
  readonly amount: string;
  /** Defaults to "open" — the pre-application state for state selection. */
  readonly currentState?: ReceivableState;
}

export type ApplyDecision =
  | { kind: "ok"; newBalance: string; newState: ReceivableState }
  | { kind: "over_application" };

/**
 * Decide the outcome of applying `amount` against a receivable with
 * `outstandingBalance`. Clearing (amount === balance) → settled; partial
 * (0 < amount < balance) → partially_applied; amount > balance →
 * over_application (rejected, no truncation, the contract's 409).
 */
export function decideApplication(input: ApplyInput): ApplyDecision {
  const balance = toScaledInt(input.outstandingBalance);
  const amount = toScaledInt(input.amount);

  if (amount > balance) {
    return { kind: "over_application" };
  }
  const newBalance = balance - amount;
  const newState: ReceivableState = newBalance === 0n ? "settled" : "partially_applied";
  return { kind: "ok", newBalance: fromScaledInt(newBalance), newState };
}
