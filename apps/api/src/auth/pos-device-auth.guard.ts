/**
 * PosDeviceAuthGuard — device-principal authentication for the 010 read-down
 * catalogue routes (issue #488, Option B-prime).
 *
 * Why this exists
 * ---------------
 * The read-down snapshot/delta API (`/api/pos/v1/catalog/snapshot|deltas`)
 * must authenticate a POS terminal by its `devices` PAIRING TOKEN alone — with
 * NO operator session — because POS-Pulse triggers the read-down as a
 * paired-terminal background sync (no cashier signed in). The shared
 * `PosOperatorAuthGuard` requires `scope === "pos_operator"`, a credential that
 * only exists AFTER an operator sign-in; it correctly rejects a bare device
 * principal. Rather than broaden that guard (it also protects `posCaptureItem`
 * and the 008 sales routes — 002 FR-POS-AUTH-4/5), this is a SEPARATE guard
 * scoped to the read-down routes only.
 *
 * What it does
 * ------------
 * 1. Reads the device pairing token from `Authorization: Bearer <token>` (the
 *    same transport `AuthGuard` uses; the backend has no `X-Terminal-Token`
 *    seam — POS sends the device token in the Authorization header for this
 *    read-only surface).
 * 2. Resolves it via `DeviceRepository.findActiveByAttestation` — a stateless
 *    SHA-256 hash → UNIQUE-index probe on `devices.token_hash`, returning the
 *    store-bound `DeviceRow` iff `revoked_at IS NULL` (the same lookup POS
 *    operator sign-in uses; it needs no established tenant context).
 * 3. On success, publishes a device principal context onto `request.context`:
 *    `(tenant_id, store_id)` come from the device ROW — the authority — never
 *    from the request body/query (FR-002). The read-down controller's existing
 *    `store_context_required` / non-disclosing `branch_id`-mismatch logic then
 *    runs unchanged.
 *
 * Failure posture (FR-001, non-disclosing)
 * ----------------------------------------
 * Missing/malformed Authorization header, an unknown/revoked device token, or
 * any non-device credential (a dashboard cookie session, a non-Bearer scheme)
 * all collapse to the SAME generic `UnauthorizedException` (401) — no signal
 * about why. Dashboard cookies are ignored entirely: this guard only ever
 * trusts a Bearer device token.
 *
 * READ-DOWN ROUTES ONLY. Do NOT register globally or reuse on operator routes.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { DeviceRepository } from "../pos-operators/device.repository";
import type { Principal } from "./auth.guard";
import type { ResolvedContext, TenantContextRequest } from "../context/types";

const BEARER_PREFIX = "bearer ";

@Injectable()
export class PosDeviceAuthGuard implements CanActivate {
  constructor(private readonly devices: DeviceRepository) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();

    const rawToken = readBearerToken(request);
    if (rawToken === null) throw unauthorized();

    const device = await this.devices.findActiveByAttestation(rawToken);
    if (!device) throw unauthorized();

    // Publish a device PRINCIPAL (mirrors the `pos`-scope token principal
    // shape) so the global AuditEmitterInterceptor records a faithful
    // read-access actor (FR-080): there is NO operator user on a background
    // device read-down, so `userId` is null (a person did not act — the
    // terminal did); the device IS the token, so `tokenId` is the device id.
    const principal: Principal = {
      kind: "token",
      tokenId: device.id,
      tenantId: device.tenantId,
      userId: null,
      storeId: device.storeId,
      scope: "pos",
    };
    request.principal = principal;

    // Scope is taken from the authenticated device ROW only (FR-002). The
    // device principal carries no operator identity, so userId is null.
    const context: ResolvedContext = {
      userId: null,
      tenantId: device.tenantId,
      storeId: device.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    request.context = context;
    return true;
  }
}

/**
 * Extract the raw bearer token from the `Authorization` header. Mirrors
 * `auth.guard.ts`'s `readBearerToken` (case-insensitive prefix, trimmed,
 * non-empty) so the device token is accepted exactly as other bearers are.
 * Returns null for a missing, non-Bearer, or empty header.
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

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
