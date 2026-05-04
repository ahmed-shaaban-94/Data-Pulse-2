import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { runWithTenantContext, type TenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../auth/auth.module";
import {
  EMAIL_JOB_ENQUEUER,
  type EmailJobEnqueuer,
} from "../auth/email-job.enqueuer";
import type { ResolvedContext } from "../context/types";
import type { InvitationRow } from "@data-pulse-2/db/schema";
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
    tx?: TenantTxRunner,
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
}
