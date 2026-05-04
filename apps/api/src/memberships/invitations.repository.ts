import { Injectable } from "@nestjs/common";
import {
  invitations,
  roles,
  stores,
  type InvitationRow,
} from "@data-pulse-2/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PoolClient } from "pg";

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
}
