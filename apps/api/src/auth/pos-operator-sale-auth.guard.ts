/**
 * PosOperatorSaleAuthGuard — Clerk-JWT auth for the POS sale-sync routes
 * (008 Option Y, owner-ratified 2026-06-10).
 *
 * Why this exists
 * ---------------
 * The POS app holds a Clerk session JWT (the operator's identity) and the
 * paired terminal's device token — it does NOT hold a server-internal
 * `pos_operator` bearer (operator sign-in never returns one to the client).
 * The shared `PosOperatorAuthGuard` requires `principal.scope === "pos_operator"`,
 * a credential the client can never present. Rather than mint/return such a
 * token, the sale routes authenticate the SAME way operator sign-in does:
 *
 *   - `Authorization: Bearer <clerk-jwt>`   (the operator identity)
 *   - body `deviceTokenAttestation`         (the paired-terminal proof)
 *
 * The guard runs the shared `OperatorContextResolver` (Clerk-verify → user →
 * device → membership → role/store eligibility) and publishes the resolved
 * `(tenant_id, store_id, user_id)` onto `request.context` — scoped FROM the
 * device row + membership, never from the sale body (FR-061). The sale
 * controller's existing `req.context` null-checks then run unchanged.
 *
 * Note on transport: unlike the read-down `PosDeviceAuthGuard` (which puts the
 * DEVICE token in `Authorization`), these routes put the CLERK JWT in
 * `Authorization` and the device attestation in the BODY — matching the
 * operator sign-in convention. A sale needs BOTH the operator identity and the
 * terminal proof.
 *
 * Failure posture (non-disclosing): a missing/malformed Authorization header,
 * a missing/empty attestation, an invalid JWT, an unmapped/disabled user, a
 * revoked device, an ineligible role, or a store-access miss ALL collapse to
 * the SAME generic `UnauthorizedException` (401). No factor disclosure.
 *
 * SALE ROUTES ONLY. Do NOT register globally or reuse on read-down / operator
 * sign-in routes.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import {
  OPERATOR_CONTEXT_RESOLVER,
  type OperatorContextResolver,
} from "./operator-context-resolver";
import type { TenantContextRequest } from "../context/types";

const BEARER_PREFIX = "bearer ";

@Injectable()
export class PosOperatorSaleAuthGuard implements CanActivate {
  // The resolver is a string-token seam (interface, not a class), so it MUST
  // be injected with an explicit @Inject — otherwise Nest, instantiating this
  // guard by class for @UseGuards(PosOperatorSaleAuthGuard), reads the erased
  // constructor type (Object) and fails to resolve the dependency.
  constructor(
    @Inject(OPERATOR_CONTEXT_RESOLVER)
    private readonly resolver: OperatorContextResolver,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();

    const rawJwt = readBearerToken(request);
    if (rawJwt === null) throw unauthorized();

    const attestation = readBodyAttestation(request);
    if (attestation === null) throw unauthorized();

    const result = await this.resolver.resolve(rawJwt, attestation);
    if (result.kind !== "ok") throw unauthorized();

    request.context = result.context;
    return true;
  }
}

/**
 * Extract the raw bearer token (the Clerk JWT) from the `Authorization`
 * header. Mirrors `auth.guard.ts` — case-insensitive prefix, trimmed,
 * non-empty. Returns null for a missing, non-Bearer, or empty header.
 */
function readBearerToken(request: TenantContextRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  if (header.length < BEARER_PREFIX.length) return null;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return null;
  }
  const raw = header.slice(BEARER_PREFIX.length).trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Read the device-token attestation from the parsed request body. Guards run
 * BEFORE the route's Zod validation pipe, so the body has been JSON-parsed by
 * the global body parser but not yet schema-validated — we read the field
 * defensively here. Returns null if the body is absent, not an object, or the
 * attestation is missing / not a non-empty string.
 */
function readBodyAttestation(request: TenantContextRequest): string | null {
  const body: unknown = (request as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)["deviceTokenAttestation"];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
