import * as argon2 from "argon2";

/**
 * argon2id parameters per the OWASP Password Storage Cheat Sheet (2025).
 *
 * Floor for argon2id at the time of writing:
 *   - memoryCost: 19456 KiB (= 19 MiB)
 *   - timeCost:   2 iterations
 *   - parallelism: 1 lane
 *   - hashLength: 32 bytes
 *
 * If you raise these, also bump `needsRehash`'s threshold check so existing
 * users get re-hashed on next successful login.
 */
export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  return argon2.hash(plaintext, ARGON2_PARAMS);
}

/**
 * Constant-time verify. Returns false (never throws) on malformed input or
 * mismatch, so callers can treat the boolean as the only signal.
 */
export async function verifyPassword(
  phcString: string,
  candidate: string,
): Promise<boolean> {
  if (typeof phcString !== "string" || phcString.length === 0) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    return await argon2.verify(phcString, candidate);
  } catch {
    return false;
  }
}

/**
 * Returns true if the given PHC hash was produced with weaker parameters than
 * the current floor (or is malformed). Use after a successful verify to
 * upgrade the user's hash transparently:
 *
 *   if (await verifyPassword(stored, candidate)) {
 *     if (needsRehash(stored)) await save(await hashPassword(candidate));
 *   }
 */
export function needsRehash(phcString: string): boolean {
  try {
    return argon2.needsRehash(phcString, ARGON2_PARAMS);
  } catch {
    return true;
  }
}
