/**
 * PosOperatorsService — Wave 1 sign-in orchestrator.
 *
 * Pipeline (every step on failure → typed `refused` result, mapped at
 * the controller boundary to the same generic 401 envelope; ADR D10):
 *
 *   1. Verify the Clerk JWT (signature, iss, aud, exp, nbf, iat).
 *   2. Resolve the local user by `users.clerk_user_id = sub`.
 *      Reject if missing, soft-deleted, or the column is unset (no JIT).
 *   3. Resolve the device by `device_token_attestation` (hash lookup),
 *      filter out revoked rows. The device row carries the canonical
 *      `(tenant_id, store_id)` scope.
 *   4. Resolve the operator's membership in that tenant; the membership
 *      role MUST be one of {owner, tenant_admin, store_manager}. Soft-
 *      deleted or revoked memberships are rejected.
 *   5. Confirm store eligibility:
 *      - `store_access_kind = 'all'` → eligible for any store in the
 *        tenant (PR-3 schema does not gate this further);
 *      - `store_access_kind = 'specific'` → eligible only if `store_access`
 *        contains `(membership_id, store_id)`.
 *   6. (Wave 1) Detect existing active POS operator session for the
 *      same `(device, store)` and return `takeover_required` instead of
 *      issuing a new session.
 *   7. Otherwise issue a new `auth_tokens` row with scope `pos_operator`
 *      bound to `(user_id, device_id, tenant_id, store_id)` and return
 *      its `id` + `issued_at` as the operator session summary. The
 *      `token_hash` column is populated with a server-internal opaque
 *      value that is **never** returned to the POS client (ADR D8 final
 *      paragraph).
 *
 * No log line, audit row, or error message ever contains the Clerk JWT,
 * the device token attestation, the user's password hash, or any internal
 * secret (FR-POS-AUTH-10, FR-POS-AUTH-8).
 */
import { Injectable } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import type { Logger } from "@data-pulse-2/shared";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";

import type { ClerkVerifier } from "./clerk-verifier";
import { DeviceRepository } from "./device.repository";
import type {
  PosOperatorRole,
  PosOperatorSessionSummaryBody,
  PosOperatorSignInInput,
  PosOperatorSignInResponseBody,
  PosOperatorSummaryBody,
} from "./dto";

/**
 * Default operator-session TTL. Wave 1 operator sessions are
 * server-side state with a fixed expiry; they are not refreshable
 * (FR-POS-AUTH-5). 8 hours is a working-shift-aligned default; the
 * deployment configuration story is deferred (open question §9).
 */
const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Internal role codes that may sign in via the `manager_admin` surface.
 * Values map to the POS-facing `manager` / `admin` enum at the response
 * boundary.
 */
const ELIGIBLE_INTERNAL_ROLES = new Set([
  "owner",
  "tenant_admin",
  "store_manager",
]);

function mapInternalRoleToPos(internalCode: string): PosOperatorRole | null {
  if (internalCode === "owner" || internalCode === "tenant_admin") return "admin";
  if (internalCode === "store_manager") return "manager";
  return null;
}

export type SignInResult =
  | {
      kind: "signed_in";
      operator: PosOperatorSummaryBody;
      operator_session: PosOperatorSessionSummaryBody;
    }
  | { kind: "takeover_required" }
  | { kind: "refused"; reason: SignInRefusalReason };

/**
 * Internal refusal taxonomy. The reason is logged server-side keyed by
 * `request_id` (ADR D10) but is never enumerated in the response body.
 * Adding a value here is a server-side observability change, not a
 * contract change.
 */
export type SignInRefusalReason =
  | "clerk_jwt_invalid"
  | "user_unmapped"
  | "user_disabled"
  | "device_invalid"
  | "membership_missing"
  | "membership_revoked"
  | "role_ineligible"
  | "store_not_in_access_set"
  | "tenant_mismatch";

@Injectable()
export class PosOperatorsService {
  constructor(
    private readonly pool: Pool,
    private readonly clerkVerifier: ClerkVerifier,
    private readonly deviceRepository: DeviceRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Run the sign-in pipeline. The caller (controller) is responsible for
   * mapping any non-`signed_in` / non-`takeover_required` result to the
   * uniform 401. The shape of `requestId` is part of the structured-log
   * key under which the actual cause is recorded.
   */
  async signIn(
    rawJwt: string,
    body: PosOperatorSignInInput,
    requestId: string,
  ): Promise<PosOperatorSignInResponseBody | { kind: "refused" }> {
    const result = await this.runPipeline(rawJwt, body);
    if (result.kind === "refused") {
      // Server-side cause record — keyed by request_id, never returned
      // to the client. The Clerk JWT and the device attestation are
      // intentionally excluded from this log line (FR-POS-AUTH-10,
      // FR-POS-AUTH-2).
      this.logger.warn(
        { request_id: requestId, refusal: result.reason },
        "pos-operator sign-in refused",
      );
      return { kind: "refused" };
    }
    return result;
  }

  private async runPipeline(
    rawJwt: string,
    body: PosOperatorSignInInput,
  ): Promise<SignInResult> {
    // 1. Clerk JWT verification.
    let claims;
    try {
      claims = await this.clerkVerifier.verify(rawJwt);
    } catch {
      return { kind: "refused", reason: "clerk_jwt_invalid" };
    }

    // 2. Map Clerk subject → local user.
    const userRow = await this.findUserByClerkSubject(claims.sub);
    if (!userRow) return { kind: "refused", reason: "user_unmapped" };
    if (userRow.deleted_at !== null) {
      return { kind: "refused", reason: "user_disabled" };
    }

    // 3. Device — hash the attestation, look up active row.
    const deviceRow = await this.deviceRepository.findActiveByAttestation(
      body.device_token_attestation,
    );
    if (!deviceRow) return { kind: "refused", reason: "device_invalid" };

    // 4. Membership in the device's tenant + role eligibility.
    const membership = await this.findActiveMembership(
      deviceRow.tenantId,
      userRow.id,
    );
    if (!membership) return { kind: "refused", reason: "membership_missing" };
    if (membership.revoked_at !== null || membership.deleted_at !== null) {
      return { kind: "refused", reason: "membership_revoked" };
    }
    if (!ELIGIBLE_INTERNAL_ROLES.has(membership.role_code)) {
      return { kind: "refused", reason: "role_ineligible" };
    }
    const posRole = mapInternalRoleToPos(membership.role_code);
    if (posRole === null) return { kind: "refused", reason: "role_ineligible" };

    // 5. Store eligibility: 'all' → unconditional, 'specific' → must be in access set.
    if (membership.store_access_kind === "specific") {
      const ok = await this.storeIsInAccessSet(
        membership.id,
        deviceRow.storeId,
      );
      if (!ok) return { kind: "refused", reason: "store_not_in_access_set" };
    }

    // 6. Active operator session check → takeover_required (minimum disclosure).
    const hasActiveSession = await this.activeOperatorSessionExists(
      deviceRow.id,
      deviceRow.storeId,
    );
    if (hasActiveSession) return { kind: "takeover_required" };

    // 7. Issue server-side operator session row.
    const session = await this.issueOperatorSessionRow({
      tenantId: deviceRow.tenantId,
      storeId: deviceRow.storeId,
      userId: userRow.id,
      deviceId: deviceRow.id,
    });

    return {
      kind: "signed_in",
      operator: {
        id: userRow.clerk_user_id ?? "",
        display_name: userRow.display_name ?? userRow.email,
        role: posRole,
        tenant_id: deviceRow.tenantId,
        // FR-POS-AUTH-7: internal `store_id` is surfaced as `branch_id`.
        branch_id: deviceRow.storeId,
      },
      operator_session: {
        id: session.id,
        issued_at: session.issuedAt.toISOString(),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Direct SQL — kept inline rather than spreading across micro-repos.
  // Each query has a single caller in this service.
  // -----------------------------------------------------------------------

  private async findUserByClerkSubject(sub: string): Promise<UserLookupRow | null> {
    const r = await this.pool.query<UserLookupRow>(
      `SELECT id, email, display_name, clerk_user_id, deleted_at
         FROM users
        WHERE clerk_user_id = $1
        LIMIT 1`,
      [sub],
    );
    return r.rows[0] ?? null;
  }

  private async findActiveMembership(
    tenantId: string,
    userId: string,
  ): Promise<MembershipLookupRow | null> {
    const r = await this.pool.query<MembershipLookupRow>(
      `SELECT m.id, m.tenant_id, m.user_id, m.role_id,
              m.store_access_kind, m.revoked_at, m.deleted_at,
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

  private async storeIsInAccessSet(
    membershipId: string,
    storeId: string,
  ): Promise<boolean> {
    const r = await this.pool.query<{ one: number }>(
      `SELECT 1 AS one
         FROM store_access
        WHERE membership_id = $1
          AND store_id = $2
        LIMIT 1`,
      [membershipId, storeId],
    );
    return r.rows.length > 0;
  }

  private async activeOperatorSessionExists(
    deviceId: string,
    storeId: string,
  ): Promise<boolean> {
    const r = await this.pool.query<{ one: number }>(
      `SELECT 1 AS one
         FROM auth_tokens
        WHERE scope = 'pos_operator'
          AND device_id = $1
          AND store_id = $2
          AND revoked_at IS NULL
          AND expires_at > now()
        LIMIT 1`,
      [deviceId, storeId],
    );
    return r.rows.length > 0;
  }

  private async issueOperatorSessionRow(input: {
    tenantId: string;
    storeId: string;
    userId: string;
    deviceId: string;
  }): Promise<{ id: string; issuedAt: Date }> {
    const id = newId();
    // The token_hash column is NOT NULL UNIQUE. Wave 1 stores a server-
    // generated opaque hash here as session-state storage only — the raw
    // value is never returned to the client (ADR D8). Generating a fresh
    // raw value per row guarantees uniqueness without coupling row id and
    // token material.
    const opaqueRaw = generateRawToken();
    const tokenHash = hashToken(opaqueRaw);
    const expiresAt = new Date(Date.now() + OPERATOR_SESSION_TTL_MS);
    const r = await this.pool.query<{ id: string; issued_at: Date }>(
      `INSERT INTO auth_tokens
         (id, token_hash, tenant_id, user_id, device_id, store_id,
          scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator', $7)
       RETURNING id, issued_at`,
      [id, tokenHash, input.tenantId, input.userId, input.deviceId, input.storeId, expiresAt],
    );
    const row = r.rows[0];
    if (!row) throw new Error("PosOperatorsService.issueOperatorSessionRow: insert returned no row");
    return { id: row.id, issuedAt: row.issued_at };
  }
}

interface UserLookupRow {
  id: string;
  email: string;
  display_name: string | null;
  clerk_user_id: string | null;
  deleted_at: Date | null;
}

interface MembershipLookupRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role_id: string;
  store_access_kind: "all" | "specific";
  revoked_at: Date | null;
  deleted_at: Date | null;
  role_code: string;
}
