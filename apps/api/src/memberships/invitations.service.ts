import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { runWithTenantContext, type TenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../auth/auth.module";
import {
  EMAIL_JOB_ENQUEUER,
  type EmailJobEnqueuer,
} from "../auth/email-job.enqueuer";
import type { ResolvedContext } from "../context/types";
import { roles, type InvitationRow } from "@data-pulse-2/db/schema";
import type { MembershipDetail } from "../context/membership.repository";
import type { InvitationCreateDto } from "./invitation.dto";
import { InvitationsRepository } from "./invitations.repository";

type TenantTxRunner = <T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

function txCtx(ctx: ResolvedContext): TenantContext {
  return {
    tenantId: ctx.tenantId,
    isPlatformAdmin: ctx.isPlatformAdmin,
  };
}

const PLATFORM_ADMIN_CODE = "platform_admin";
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Uniform error thrown for every invalid-token case — no enumeration detail. */
const INVALID_INVITATION_ERROR = "Invalid or expired invitation token";

/** Platform-admin context used for unauthenticated token lookups (RLS bypass). */
const PLATFORM_ADMIN_CTX: TenantContext = { tenantId: null, isPlatformAdmin: true };

@Injectable()
export class InvitationsService {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly invitations: InvitationsRepository,
    @Inject(EMAIL_JOB_ENQUEUER)
    private readonly emailEnqueuer: EmailJobEnqueuer,
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  /**
   * `POST /api/v1/memberships/invite`.
   *
   * Returns the invitation row on success. The raw token is returned to
   * the caller for email dispatch but is NEVER included in the HTTP response.
   */
  async invite(
    ctx: ResolvedContext,
    dto: InvitationCreateDto,
  ): Promise<InvitationRow> {
    const tenantId = ctx.tenantId as string;
    const invitedByUserId = ctx.userId;
    if (!invitedByUserId) throw new UnauthorizedException("Unauthorized");

    const normalizedEmail = dto.email.trim().toLowerCase();

    let rawToken!: string;

    const row = await this.tx(this.pool, txCtx(ctx), async (client) => {
      // Step 1: validate role_code
      if (dto.role_code === PLATFORM_ADMIN_CODE) {
        throw new BadRequestException(
          "platform_admin is a platform-level role and cannot be assigned to a tenant membership",
        );
      }
      const roleId = await this.invitations.findRoleId(client, tenantId, dto.role_code);
      if (!roleId) {
        throw new BadRequestException(`Unknown role_code: ${dto.role_code}`);
      }

      // Step 2: validate store_ids belong to active tenant
      const storeIds = dto.store_ids ?? [];
      if (storeIds.length > 0) {
        const invalid = await this.invitations.findInvalidStoreIds(client, tenantId, storeIds);
        if (invalid.length > 0) {
          throw new BadRequestException(
            `store_ids not found in active tenant: ${invalid.join(", ")}`,
          );
        }
      }

      // Step 3: auto-expire stale pending invites for this email
      await this.invitations.autoExpireStale(client, tenantId, normalizedEmail);

      // Step 4: conflict check — non-expired pending invite
      const hasPending = await this.invitations.findPendingByEmail(
        client,
        tenantId,
        normalizedEmail,
      );
      if (hasPending) {
        throw new ConflictException(
          "A pending invitation already exists for this email address",
        );
      }

      // Step 5: generate token — raw token stays in closure, never stored
      rawToken = generateRawToken();
      const tokenHash = hashToken(rawToken);

      // Step 6: insert invitation row
      return this.invitations.create(client, {
        id: newId(),
        tenantId,
        email: normalizedEmail,
        roleId,
        storeAccessKind: dto.store_access_kind,
        invitedStoreIds: [...new Set(storeIds)],
        invitedByUserId,
        tokenHash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      });
    });

    // Step 7: enqueue email AFTER the transaction commits
    await this.emailEnqueuer.enqueueInvitation({
      email: normalizedEmail,
      rawToken,
      tenantId,
    });

    return row;
  }

  /**
   * Accept-token lookup foundation.
   *
   * Hashes `rawToken`, looks up the invitation by token_hash using a
   * platform-admin context (RLS bypassed at the policy layer — the invitee
   * has no session and no known tenant yet), then validates status and expiry.
   *
   * Returns the validated `InvitationRow` to internal service callers only.
   * NEVER exposed directly on an HTTP endpoint; the raw token and token_hash
   * are not included in any return value.
   *
   * Throws `BadRequestException` with the same opaque message for every
   * invalid case (not found, expired, revoked, accepted, or otherwise
   * non-pending) — no enumeration detail leaks to callers.
   *
   * This method is read-only: no mutations, no membership/user/session creation,
   * no accepted_at / accepted_by_user_id update.
   */
  async lookupAndValidateAcceptToken(rawToken: string): Promise<InvitationRow> {
    const tokenHash = hashToken(rawToken);

    const row = await this.tx(
      this.pool,
      PLATFORM_ADMIN_CTX,
      async (client) => this.invitations.findByTokenHash(client, tokenHash),
    );

    if (!row) {
      throw new BadRequestException(INVALID_INVITATION_ERROR);
    }

    if (row.status !== "pending") {
      throw new BadRequestException(INVALID_INVITATION_ERROR);
    }

    if (row.expiresAt <= new Date()) {
      throw new BadRequestException(INVALID_INVITATION_ERROR);
    }

    return row;
  }

  /**
   * Accept an invitation for an existing user (existing-user path only).
   *
   * Sequence (deferred-user path — no session/cookie/new-user creation):
   *   1. Validate the token (same logic as `lookupAndValidateAcceptToken`).
   *   2. Look up the invitee by email BEFORE opening the mutation transaction,
   *      so an unknown email leaves the invitation `status='pending'`.
   *      Throws `NotFoundException` when no active user matches.
   *   3. Single mutation transaction (platform-admin context, tenant_id=row.tenantId):
   *      a. `markAccepted` — conditional UPDATE guards against concurrent races.
   *         Returns `false` (race lost) → same opaque `BadRequestException`.
   *      b. `createMembership` — INSERT; DB enforces
   *         `memberships_tenant_user_active_uidx` partial unique index.
   *         `23505` on that constraint → `ConflictException(409)`; the
   *         invitation remains `accepted` (the accept was valid, the conflict
   *         is a business-logic condition the caller must resolve).
   *      c. `insertStoreAccessRows` — only when `storeAccessKind='specific'`
   *         and `invitedStoreIds` is non-empty.
   *   4. Build and return `MembershipDetail` (NOT `InvitationRow` — never
   *      expose `tokenHash`).
   *
   * No session is created. No cookie is set. This is a pure mutation
   * foundation for the deferred HTTP layer.
   */
  async acceptInvitationExistingUser(rawToken: string): Promise<MembershipDetail> {
    // Step 1: validate token (read-only, outside tx)
    const invitation = await this.lookupAndValidateAcceptToken(rawToken);

    // Step 2: look up user by email BEFORE mutation tx
    const user = await this.tx(
      this.pool,
      PLATFORM_ADMIN_CTX,
      async (client) => this.invitations.findUserByEmail(client, invitation.email),
    );
    if (!user) {
      throw new NotFoundException("No account found for this invitation email. Please register first.");
    }

    // Step 3: single mutation transaction under the invitation's tenant
    const txContext: TenantContext = {
      tenantId: invitation.tenantId,
      isPlatformAdmin: true,
    };

    return this.tx(this.pool, txContext, async (client) => {
      // 3a: mark invitation accepted (conditional — race-safe)
      const accepted = await this.invitations.markAccepted(client, invitation.id, user.id);
      if (!accepted) {
        throw new BadRequestException(INVALID_INVITATION_ERROR);
      }

      // 3b: create membership
      const membershipId = newId();
      const storeAccessKind = invitation.storeAccessKind as "all" | "specific";
      try {
        await this.invitations.createMembership(client, {
          id: membershipId,
          tenantId: invitation.tenantId,
          userId: user.id,
          roleId: invitation.roleId,
          storeAccessKind,
        });
      } catch (err: unknown) {
        if (isUniqueViolation(err, "memberships_tenant_user_active_uidx")) {
          throw new ConflictException(
            "An active membership already exists for this user in this tenant",
          );
        }
        throw err;
      }

      // 3c: insert store_access rows when kind is 'specific'
      const storeIds: string[] = Array.isArray(invitation.invitedStoreIds)
        ? invitation.invitedStoreIds
        : [];
      if (storeAccessKind === "specific" && storeIds.length > 0) {
        await this.invitations.insertStoreAccessRows(
          client,
          membershipId,
          invitation.tenantId,
          storeIds,
        );
      }

      // Step 4: build MembershipDetail response (no tokenHash)
      const accessibleStoreIds: readonly string[] =
        storeAccessKind === "specific" ? storeIds : [];

      // Re-read role code from the invitation's roleId via a roles lookup
      // (the invitation row stores roleId not roleCode)
      const roleCode = await getRoleCode(client, invitation.roleId, invitation.tenantId);

      return {
        membershipId,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName ?? null,
        },
        roleCode,
        storeAccessKind,
        accessibleStoreIds,
        revokedAt: null,
      };
    });
  }
}

/**
 * Fetch the `code` column for a role row by ID within a specific tenant.
 *
 * The `tenantId` constraint is defence-in-depth: roles are tenant-scoped
 * and the mutation context already holds `invitation.tenantId`, so we
 * constrain to the same tenant rather than relying on ID uniqueness alone.
 *
 * Throws if the role cannot be found (should never happen given FK
 * integrity, but guards against a corrupt state).
 */
async function getRoleCode(
  client: PoolClient,
  roleId: string,
  tenantId: string,
): Promise<string> {
  const db = drizzle(client);
  const rows = await db
    .select({ code: roles.code })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`getRoleCode: role ${roleId} not found`);
  return row.code;
}

/**
 * Detect a Postgres unique-constraint violation (`SQLSTATE 23505`) on
 * a specific constraint name. Mirrors `StoresService.isUniqueViolation`.
 *
 * Drizzle wraps the underlying `pg` error in a `DrizzleQueryError` whose
 * `.cause` carries the `pg.DatabaseError` with `code='23505'` and the
 * constraint name. We recurse one level into `.cause` so the wrapping
 * doesn't defeat the check.
 */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: unknown;
  };
  if (e.code === "23505") {
    if (e.constraint === constraintName) return true;
    if (typeof e.message === "string" && e.message.includes(constraintName)) {
      return true;
    }
  }
  if (e.cause && typeof e.cause === "object") {
    return isUniqueViolation(e.cause, constraintName);
  }
  return typeof e.message === "string" && e.message.includes(constraintName);
}
