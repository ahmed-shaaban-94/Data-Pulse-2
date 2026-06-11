/**
 * operator-context-resolver.ts — 008 Option Y.
 *
 * Reusable POS-operator identity + eligibility resolution. Given a Clerk JWT
 * and a device-token attestation, it runs the SAME derivation the operator
 * sign-in pipeline uses and returns a `ResolvedContext` scoped from the device
 * row + membership — or a typed refusal.
 *
 * This is the shared trust core for the POS sale-sync surface (Option Y,
 * owner-ratified 2026-06-10): the sale endpoints authenticate exactly like
 * `POST /api/pos/v1/operators/sign-in` — Clerk JWT in `Authorization` +
 * device attestation in the body — instead of requiring a server-internal
 * `pos_operator` bearer that sign-in never issues to clients.
 *
 * Derivation (mirrors PosOperatorsService.runPipeline steps 1–5):
 *   1. Verify the Clerk JWT (signature, iss, aud, exp) → { sub }.
 *   2. Resolve the local user by `users.clerk_user_id = sub`; reject if
 *      missing or soft-deleted.
 *   3. Resolve the device by attestation hash (active rows only); the device
 *      row carries the canonical `(tenant_id, store_id)`.
 *   4. Resolve the operator's membership in the device's tenant; role MUST be
 *      one of {owner, tenant_admin, store_manager}; reject revoked / deleted.
 *   5. Store eligibility: `all` → any store in tenant; `specific` → must be in
 *      the access set for the device's store.
 *
 * On success, publishes `(tenant_id, store_id)` FROM the device row (the
 * authority) and `user_id` from the local user — NEVER from any request body
 * (FR-061 mass-assignment ban). Every failure is a typed `refused` reason,
 * logged server-side by the caller and collapsed to a generic 401 at the
 * boundary (no factor disclosure).
 *
 * The Clerk JWT and device attestation are never logged, persisted, or
 * returned (FR-POS-AUTH-10 / ADR D3).
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import type { ClerkVerifier } from "../pos-operators/clerk-verifier";
import { DeviceRepository } from "../pos-operators/device.repository";
import type { ResolvedContext } from "../context/types";

/**
 * Internal roles eligible for the POS manager/admin surface. Mirrors
 * `ELIGIBLE_INTERNAL_ROLES` in PosOperatorsService — store_staff (cashier) is
 * NOT eligible to ring a manager/admin-authenticated sale via this path.
 */
const ELIGIBLE_INTERNAL_ROLES = new Set(["owner", "tenant_admin", "store_manager"]);

export type ResolveOperatorRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "device_invalid"
  | "membership_missing"
  | "membership_revoked"
  | "role_ineligible"
  | "store_not_in_access_set";

export type ResolveOperatorResult =
  | { kind: "ok"; context: ResolvedContext; deviceId: string }
  | { kind: "refused"; reason: ResolveOperatorRefusalReason };

/**
 * Resolver seam. The guard depends on this interface; production wires
 * `PgOperatorContextResolver`, unit tests inject a fake.
 */
export interface OperatorContextResolver {
  resolve(rawJwt: string, rawAttestation: string): Promise<ResolveOperatorResult>;
}

/** DI token for the resolver. */
export const OPERATOR_CONTEXT_RESOLVER = "OPERATOR_CONTEXT_RESOLVER";

interface UserLookupRow {
  id: string;
  deleted_at: Date | null;
}

interface MembershipLookupRow {
  id: string;
  store_access_kind: "all" | "specific";
  revoked_at: Date | null;
  deleted_at: Date | null;
  role_code: string;
}

/** Minimal structured-logger surface (pino-compatible); optional. */
export interface ResolverLogger {
  warn(obj: object, msg: string): void;
}

@Injectable()
export class PgOperatorContextResolver implements OperatorContextResolver {
  constructor(
    private readonly pool: Pool,
    private readonly clerkVerifier: ClerkVerifier,
    private readonly deviceRepository: DeviceRepository,
    private readonly logger?: ResolverLogger,
  ) {}

  async resolve(rawJwt: string, rawAttestation: string): Promise<ResolveOperatorResult> {
    // 1. Clerk JWT verification.
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch (err) {
      // Collapse to a generic refusal at the boundary (no factor disclosure),
      // but record the underlying cause server-side so operators can debug
      // Clerk connectivity / config / outage. The raw JWT is NEVER logged
      // (FR-POS-AUTH-10) — only the error.
      this.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "operator-context-resolver: Clerk JWT verification failed",
      );
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // 2. Map Clerk subject → local user.
    const userRow = await this.findUserByClerkSubject(claims.sub);
    if (!userRow) return { kind: "refused", reason: "user_unmapped" };
    if (userRow.deleted_at !== null) return { kind: "refused", reason: "user_disabled" };

    // 3. Device — hash the attestation, look up the active row (carries scope).
    const deviceRow = await this.deviceRepository.findActiveByAttestation(rawAttestation);
    if (!deviceRow) return { kind: "refused", reason: "device_invalid" };

    // 4. Membership in the device's tenant + role eligibility.
    const membership = await this.findActiveMembership(deviceRow.tenantId, userRow.id);
    if (!membership) return { kind: "refused", reason: "membership_missing" };
    if (membership.revoked_at !== null || membership.deleted_at !== null) {
      return { kind: "refused", reason: "membership_revoked" };
    }
    if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code)) {
      return { kind: "refused", reason: "role_ineligible" };
    }

    // 5. Store eligibility: 'all' → unconditional, 'specific' → must be in set.
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(membership.id, deviceRow.storeId);
      if (!ok) return { kind: "refused", reason: "store_not_in_access_set" };
    }

    // Scope FROM the device row + local user — never from request input.
    const context: ResolvedContext = {
      userId: userRow.id,
      tenantId: deviceRow.tenantId,
      storeId: deviceRow.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    // deviceId is returned so the guard can populate `request.principal`
    // (the audit interceptor reads `principal.userId` for actor_user_id, and
    // a token principal carries the device id as `tokenId` — mirrors the
    // read-down device principal).
    return { kind: "ok", context, deviceId: deviceRow.id };
  }

  private async findUserByClerkSubject(sub: string): Promise<UserLookupRow | null> {
    const r = await this.pool.query<UserLookupRow>(
      `SELECT id, deleted_at FROM users WHERE clerk_user_id = $1 LIMIT 1`,
      [sub],
    );
    return r.rows[0] ?? null;
  }

  private async findActiveMembership(
    tenantId: string,
    userId: string,
  ): Promise<MembershipLookupRow | null> {
    const r = await this.pool.query<MembershipLookupRow>(
      `SELECT m.id, m.store_access_kind, m.revoked_at, m.deleted_at,
              r.code AS role_code
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1
          AND m.user_id = $2
        LIMIT 1`,
      [tenantId, userId],
    );
    return r.rows[0] ?? null;
  }

  private async storeIsInAccessSet(membershipId: string, storeId: string): Promise<boolean> {
    const r = await this.pool.query<{ one: number }>(
      `SELECT 1 AS one FROM store_access
        WHERE membership_id = $1 AND store_id = $2 LIMIT 1`,
      [membershipId, storeId],
    );
    return r.rows.length > 0;
  }
}
