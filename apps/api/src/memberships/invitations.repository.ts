import { Injectable } from "@nestjs/common";
import {
  invitations,
  memberships,
  roles,
  storeAccess,
  stores,
  users,
  type InvitationRow,
  type MembershipRow,
  type UserRow,
} from "@data-pulse-2/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PoolClient } from "pg";

export interface CreateMembershipParams {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly storeAccessKind: "all" | "specific";
}

export interface CreateInvitationParams {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly roleId: string;
  readonly storeAccessKind: "all" | "specific";
  readonly invitedStoreIds: string[];
  readonly invitedByUserId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
}

@Injectable()
export class InvitationsRepository {
  /**
   * Set status='expired' for any pending invites matching (tenantId, email)
   * whose expires_at has passed. Called before the duplicate-pending check
   * so stale rows don't block a new invite.
   */
  async autoExpireStale(
    client: PoolClient,
    tenantId: string,
    normalizedEmail: string,
  ): Promise<void> {
    const db = drizzle(client);
    await db
      .update(invitations)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.email, normalizedEmail),
          eq(invitations.status, "pending"),
          lte(invitations.expiresAt, sql`now()`),
        ),
      );
  }

  /**
   * Returns true if a non-expired pending invitation already exists for
   * (tenantId, normalizedEmail). Caller must run autoExpireStale first.
   */
  async findPendingByEmail(
    client: PoolClient,
    tenantId: string,
    normalizedEmail: string,
  ): Promise<boolean> {
    const db = drizzle(client);
    const rows = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.email, normalizedEmail),
          eq(invitations.status, "pending"),
          isNull(invitations.deletedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Insert a new invitation row and return the full inserted record. */
  async create(
    client: PoolClient,
    params: CreateInvitationParams,
  ): Promise<InvitationRow> {
    const db = drizzle(client);
    const rows = await db
      .insert(invitations)
      .values({
        id: params.id,
        tenantId: params.tenantId,
        email: params.email,
        roleId: params.roleId,
        storeAccessKind: params.storeAccessKind,
        invitedStoreIds: params.invitedStoreIds,
        invitedByUserId: params.invitedByUserId,
        tokenHash: params.tokenHash,
        status: "pending",
        expiresAt: params.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("create invitation: INSERT returned no row");
    return row;
  }

  /**
   * Look up a role by code within tenantId. Returns null when the code
   * doesn't exist for this tenant. Callers must reject 'platform_admin'
   * before calling (platform_admin has tenantId IS NULL in the DB).
   */
  async findRoleId(
    client: PoolClient,
    tenantId: string,
    code: string,
  ): Promise<string | null> {
    const db = drizzle(client);
    const rows = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.code, code)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Look up an invitation by its token hash.
   *
   * Called from the platform-admin tenant context (tenantId=null,
   * isPlatformAdmin=true) so RLS is bypassed at the policy layer.
   * The caller is responsible for all status/expiry validation.
   * Returns null when no row matches.
   */
  async findByTokenHash(
    client: PoolClient,
    tokenHash: Buffer,
  ): Promise<InvitationRow | null> {
    const db = drizzle(client);
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Returns the subset of storeIds that do NOT belong to tenantId or are
   * soft-deleted. Empty return means all IDs are valid.
   */
  async findInvalidStoreIds(
    client: PoolClient,
    tenantId: string,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const db = drizzle(client);
    const validRows = await db
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(
          eq(stores.tenantId, tenantId),
          inArray(stores.id, ids),
          isNull(stores.deletedAt),
        ),
      );
    const validSet = new Set(validRows.map((r) => r.id));
    return ids.filter((id) => !validSet.has(id));
  }

  /**
   * Look up an active (non-deleted) user by normalised email address.
   * Returns `null` when no matching row is found.
   *
   * Called BEFORE the mutation transaction for the accept-invitation
   * flow so that an unknown-email leaves the invitation row `pending`.
   * No RLS needed — `users` has no RLS policy (data-model §1).
   */
  async findUserByEmail(
    client: PoolClient,
    normalizedEmail: string,
  ): Promise<UserRow | null> {
    const db = drizzle(client);
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.email, normalizedEmail), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Conditionally mark an invitation as accepted.
   *
   * Only updates when `status = 'pending'` AND `expires_at > now()`,
   * so concurrent accept calls collapse harmlessly: the "loser" gets
   * `rowCount = 0` and the caller maps that to the same opaque error.
   *
   * Returns `true` iff exactly one row was updated (the caller won the
   * race); `false` means the invitation was already accepted, expired,
   * revoked, or never existed under this platform-admin context.
   */
  async markAccepted(
    client: PoolClient,
    invitationId: string,
    userId: string,
  ): Promise<boolean> {
    const db = drizzle(client);
    const now = new Date();
    const result = await db
      .update(invitations)
      .set({
        status: "accepted",
        acceptedByUserId: userId,
        acceptedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, sql`now()`),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Insert a new membership row and return it.
   *
   * The caller is responsible for catching `SQLSTATE 23505` on the
   * `memberships_tenant_user_active_uidx` partial unique index and
   * mapping it to a `ConflictException` (409).
   */
  async createMembership(
    client: PoolClient,
    params: CreateMembershipParams,
  ): Promise<MembershipRow> {
    const db = drizzle(client);
    const rows = await db
      .insert(memberships)
      .values({
        id: params.id,
        tenantId: params.tenantId,
        userId: params.userId,
        roleId: params.roleId,
        storeAccessKind: params.storeAccessKind,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("createMembership: INSERT returned no row");
    return row;
  }

  /**
   * Insert `store_access` rows for a membership with `kind='specific'`.
   *
   * Called only when `storeIds.length > 0`. The composite FK
   * `(tenant_id, membership_id) → memberships(tenant_id, id)` is
   * enforced by the DB — tenantId here must match the membership's
   * tenantId (Invariant I-3).
   */
  async insertStoreAccessRows(
    client: PoolClient,
    membershipId: string,
    tenantId: string,
    storeIds: string[],
  ): Promise<void> {
    if (storeIds.length === 0) return;
    const db = drizzle(client);
    const rows = storeIds.map((storeId) => ({
      membershipId,
      storeId,
      tenantId,
    }));
    await db.insert(storeAccess).values(rows);
  }
}
