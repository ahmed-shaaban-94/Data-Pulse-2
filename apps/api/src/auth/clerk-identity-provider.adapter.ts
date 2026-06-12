/**
 * clerk-identity-provider.adapter.ts — 029 DP-2 Provider-Neutral Identity Link.
 *
 * The ONLY v1 implementation of `IdentityProviderPort` (N-6). It is the seam
 * boundary: above it everything is provider-neutral; below it the Clerk-concrete
 * verification stays contained.
 *
 *   - `verifyIdentityToken` DELEGATES to the existing `ClerkVerifier` (whose
 *     production impl calls `packages/auth`'s `verifyToken`, keeping the
 *     `@clerk/backend` dependency contained in `packages/auth` — E-3). It maps
 *     the Clerk `{ sub }` to a provider-NEUTRAL `VerifiedSubject`
 *     `{ providerKey:'clerk', issuer, subject:sub }`. NOTHING Clerk-typed leaks.
 *   - `linkExternalIdentity` writes/updates an `external_identity_links` row.
 *   - The remaining 028 §16 operations are defined seams (T5); the ones the D8 /
 *     user-admin specs will drive are stubbed here as NOT-YET-WIRED (they throw a
 *     clear "not implemented in D3" error rather than silently no-op), so a
 *     premature caller fails loudly instead of corrupting state. The conditional
 *     trio is omitted entirely (optional on the port).
 *
 * ISSUER provenance (the drift trap): the configured Clerk issuer is the SINGLE
 * source of truth shared with the 0025 backfill. `verifyIdentityToken` returns
 * THIS issuer; the backfill stamps the SAME literal. The resolver join keys on
 * (providerKey, subject) NOT issuer (v1 single-issuer), so even a future issuer
 * drift cannot fail-close an operator — issuer is stored + unique for
 * forward-compat (multi-issuer dual-link).
 *
 * The factory preserves the production fail-closed posture: in production a real
 * `CLERK_SECRET_KEY` is required (via the wrapped `clerkVerifierFactory`); there
 * is no allow-list shortcut.
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import type { ClerkVerifier } from "../pos-operators/clerk-verifier";
import { clerkVerifierFactory } from "../pos-operators/clerk-verifier";
import type {
  CreateIdentityInput,
  IdentityProfile,
  IdentityProviderPort,
  InviteUserInput,
  LinkExternalIdentityInput,
  VerifiedSubject,
} from "./identity-provider.port";

/** The v1 provider discriminator. */
export const CLERK_PROVIDER_KEY = "clerk";

/**
 * The single configured Clerk issuer — the SOURCE OF TRUTH shared with the 0025
 * backfill literal. Read from CLERK_JWT_ISSUER when set; otherwise the stable
 * default the backfill also uses. Keep these two in lockstep.
 */
export const DEFAULT_CLERK_ISSUER = "https://clerk.dp2.local";

export function clerkIssuer(): string {
  const fromEnv = process.env["CLERK_JWT_ISSUER"];
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CLERK_ISSUER;
}

@Injectable()
export class ClerkIdentityProviderAdapter implements IdentityProviderPort {
  constructor(
    private readonly verifier: ClerkVerifier,
    private readonly pool: Pool,
    private readonly issuer: string = clerkIssuer(),
  ) {}

  async verifyIdentityToken(rawToken: string): Promise<VerifiedSubject> {
    // Delegate verification to the contained Clerk seam (E-3). The verifier
    // throws on any failure; we let it propagate so the resolver collapses it.
    const claims = await this.verifier.verify(rawToken);
    // Map to a provider-NEUTRAL subject — no Clerk-typed claim leaks out.
    return {
      providerKey: CLERK_PROVIDER_KEY,
      issuer: this.issuer,
      subject: claims.sub,
    };
  }

  async linkExternalIdentity(
    input: LinkExternalIdentityInput,
  ): Promise<{ id: string }> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO external_identity_links
         (provider_key, issuer, subject, user_id, email, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (provider_key, issuer, subject) DO UPDATE
         SET email = EXCLUDED.email,
             last_verified_at = now(),
             -- RE-ACTIVATE on re-link: a previously disabled link must become
             -- usable again, else the method returns success while the resolver's
             -- active-link join still refuses the user (HIGH-2). status + disabled_at
             -- are flipped together to satisfy the disabled_at_consistent CHECK.
             status = 'active',
             disabled_at = NULL
       RETURNING id`,
      [
        input.providerKey,
        input.issuer,
        input.subject,
        input.userId,
        input.email ?? null,
      ],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error("linkExternalIdentity: insert returned no id");
    return { id };
  }

  // --- defined seams, not wired live in D3 (T5) ------------------------------
  // These throw loudly so a premature D3 caller fails fast rather than no-op'ing
  // state. The downstream lifecycle specs (D8 / user-admin) implement them.

  async getIdentityProfile(_subject: string): Promise<IdentityProfile | null> {
    throw new Error("getIdentityProfile: not wired in D3 (lifecycle seam)");
  }

  async createIdentity(_input: CreateIdentityInput): Promise<{ subject: string }> {
    throw new Error("createIdentity: not wired in D3 (lifecycle seam)");
  }

  async inviteUser(_input: InviteUserInput): Promise<{ subject: string }> {
    throw new Error("inviteUser: not wired in D3 (lifecycle seam)");
  }

  async disableIdentity(_userId: string): Promise<void> {
    throw new Error("disableIdentity: not wired in D3 (lifecycle seam)");
  }

  async enableIdentity(_userId: string): Promise<void> {
    throw new Error("enableIdentity: not wired in D3 (lifecycle seam)");
  }

  async sendPasswordReset(_email: string): Promise<void> {
    throw new Error("sendPasswordReset: not wired in D3 (lifecycle seam)");
  }
}

/** DI token re-export convenience (the canonical token is on the port file). */
export { IDENTITY_PROVIDER_PORT } from "./identity-provider.port";

/**
 * Production factory. Wraps the existing env-driven `clerkVerifierFactory` so the
 * fail-closed posture (CLERK_SECRET_KEY required in production; no allow-list
 * shortcut) is preserved verbatim — the adapter adds the neutral mapping + link
 * write on top, never a new credential path.
 */
export function clerkIdentityProviderFactory(
  pool: Pool,
): ClerkIdentityProviderAdapter {
  const verifier: ClerkVerifier = clerkVerifierFactory();
  return new ClerkIdentityProviderAdapter(verifier, pool, clerkIssuer());
}
