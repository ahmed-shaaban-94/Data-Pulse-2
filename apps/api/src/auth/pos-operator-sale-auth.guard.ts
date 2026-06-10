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
 *   - `X-Device-Attestation: <token>`       (the paired-terminal proof)
 *
 * The guard runs the shared `OperatorContextResolver` (Clerk-verify → user →
 * device → membership → role/store eligibility) and publishes the resolved
 * `(tenant_id, store_id, user_id)` onto `request.context` — scoped FROM the
 * device row + membership, never from the sale body (FR-061). The sale
 * controller's existing `req.context` null-checks then run unchanged.
 *
 * Transport — why a HEADER, not the body:
 *   - `Authorization` holds the Clerk JWT (unlike read-down's `PosDeviceAuthGuard`,
 *     which puts the device token there), so the device proof needs its own slot.
 *   - It MUST NOT ride in the request body: the body flows into the canonical
 *     `payload_hash` (provenance) and the global idempotency fingerprint, so an
 *     auth credential there would (a) bake the secret into a persisted digest
 *     and (b) make a legitimate retry after device-token rotation look like a
 *     different request (spurious 409). A header keeps the body pure sale data.
 *
 * Audit: the guard also publishes `request.principal` (a token principal whose
 * `tokenId` is the device id and `userId` is the resolved operator) so the
 * global `AuditEmitterInterceptor` records a real `actor_user_id` on
 * sale.captured / voided / refunded (it reads `principal.userId`, not context).
 *
 * Failure posture (non-disclosing): a missing/malformed Authorization header,
 * a missing/empty attestation header, an invalid JWT, an unmapped/disabled
 * user, a revoked device, an ineligible role, or a store-access miss ALL
 * collapse to the SAME generic `UnauthorizedException` (401). No disclosure.
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
import type { Principal } from "./auth.guard";
import type { TenantContextRequest } from "../context/types";

const BEARER_PREFIX = "bearer ";

/** Custom header carrying the paired-terminal device-token attestation. */
const DEVICE_ATTESTATION_HEADER = "x-device-attestation";

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

    const attestation = readAttestationHeader(request);
    if (attestation === null) throw unauthorized();

    const result = await this.resolver.resolve(rawJwt, attestation);
    if (result.kind !== "ok") throw unauthorized();

    request.context = result.context;

    // Publish a token principal so the global AuditEmitterInterceptor records
    // a real actor (`principal.userId`). The device IS the credential here, so
    // `tokenId` is the device id (mirrors the read-down device principal).
    const principal: Principal = {
      kind: "token",
      tokenId: result.deviceId,
      tenantId: result.context.tenantId,
      userId: result.context.userId,
      storeId: result.context.storeId,
      scope: "pos_operator",
    };
    request.principal = principal;

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
 * Read the device-token attestation from the `X-Device-Attestation` header.
 * Kept out of the body so it never enters the sale's `payload_hash` or the
 * idempotency fingerprint. Express lowercases incoming header names. Returns
 * null if absent, an array (duplicate header), or empty after trim.
 */
function readAttestationHeader(request: TenantContextRequest): string | null {
  const value = request.headers[DEVICE_ATTESTATION_HEADER];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
