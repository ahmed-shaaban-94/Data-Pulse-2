import { Injectable } from "@nestjs/common";
import {
  memberships,
  roles,
  storeAccess,
  stores,
  users,
  type StoreAccessKind,
} from "@data-pulse-2/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PoolClient } from "pg";
import type { MembershipDetail } from "../context/membership.repository";

export interface UpdateParams {
  readonly roleId?: string | undefined;
  readonly storeAccessKind?: StoreAccessKind | undefined;
  readonly storeIds?: string[] | undefined;
}

export interface ExistingMembership {
  readonly id: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly storeAccessKind: StoreAccessKind;
}

@Injectable()
export class MembershipsRepository {
  /**
   * Revoke the membership identified by `membershipId` within `tenantId`.
   *
   * Returns `true` iff exactly one row was updated; `false` means the
   * row was invisible (cross-tenant, already revoked, or not found).
   */
  async revoke(
    client: PoolClient,
    membershipId: string,
    tenantId: string,
  ): Promise<boolean> {
    const db = drizzle(client);
    const result = await db
      .update(memberships)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenantId, tenantId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Load the current membership row for mutation. Returns `null` when the
   * membership is not found, already revoked, soft-deleted, or belongs to
   * a different tenant (RLS filters it out).
   */
  async findActive(
    client: PoolClient,
    membershipId: string,
    tenantId: string,
  ): Promise<ExistingMembership | null> {
    const db = drizzle(client);
    const rows = await db
      .select({
        id: memberships.id,
        tenantId: memberships.tenantId,
        roleId: memberships.roleId,
        storeAccessKind: memberships.storeAccessKind,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, membershipId),
          eq(memberships.tenantId, tenantId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      roleId: row.roleId,
      storeAccessKind: row.storeAccessKind as StoreAccessKind,
    };
  }

  /**
   * Look up a role by `code` within `tenantId`. Returns `null` when the
   * code doesn't exist in this tenant. `platform_admin` is a platform-level
   * role (tenantId IS NULL in the DB) — callers must reject it before calling.
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
   * Validate that every storeId in `ids` belongs to `tenantId` and is not
   * soft-deleted. Returns the subset that is invalid (empty = all valid).
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
   * Apply role and/or store-access changes to an existing membership.
   *
   * When `storeAccessKind` is provided:
   *   - Updates `store_access_kind` on the membership row.
   *   - If `"all"`: deletes all `store_access` rows for this membership.
   *   - If `"specific"`: replaces `store_access` rows with `storeIds`.
   *
   * Returns the updated `MembershipDetail` for the response body.
   */
  async update(
    client: PoolClient,
    existing: ExistingMembership,
    params: UpdateParams,
  ): Promise<MembershipDetail> {
    const db = drizzle(client);
    const now = new Date();

    const membershipSet: Record<string, unknown> = { updatedAt: now };
    if (params.roleId !== undefined) membershipSet["roleId"] = params.roleId;
    const effectiveKind = params.storeAccessKind ?? existing.storeAccessKind;
    if (params.storeAccessKind !== undefined) membershipSet["storeAccessKind"] = params.storeAccessKind;

    await db
      .update(memberships)
      .set(membershipSet)
      .where(eq(memberships.id, existing.id));

    if (params.storeAccessKind !== undefined) {
      // Always replace store_access rows when kind changes
      await db.delete(storeAccess).where(eq(storeAccess.membershipId, existing.id));
      if (effectiveKind === "specific" && params.storeIds && params.storeIds.length > 0) {
        const rows = params.storeIds.map((storeId) => ({
          membershipId: existing.id,
          storeId,
          tenantId: existing.tenantId,
        }));
        await db.insert(storeAccess).values(rows);
      }
    } else if (params.storeIds !== undefined && params.storeIds.length > 0) {
      // store_ids only (existing kind must already be "specific", validated in service)
      await db.delete(storeAccess).where(eq(storeAccess.membershipId, existing.id));
      const rows = params.storeIds.map((storeId) => ({
        membershipId: existing.id,
        storeId,
        tenantId: existing.tenantId,
      }));
      await db.insert(storeAccess).values(rows);
    }

    // Re-read for the response: role code + final store list
    const detailRows = await db
      .select({
        roleCode: roles.code,
        userId: memberships.userId,
        revokedAt: memberships.revokedAt,
        storeAccessKind: memberships.storeAccessKind,
      })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.id, existing.id))
      .limit(1);

    const detail = detailRows[0];
    if (!detail) throw new Error("update: membership vanished after update");

    const finalKind = detail.storeAccessKind as StoreAccessKind;
    let accessibleStoreIds: readonly string[] = [];
    if (finalKind === "specific") {
      const grantRows = await db
        .select({ storeId: storeAccess.storeId })
        .from(storeAccess)
        .where(eq(storeAccess.membershipId, existing.id));
      accessibleStoreIds = grantRows.map((r) => r.storeId);
    }

    // Re-read user fields for the response
    const userRows = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, detail.userId))
      .limit(1);
    const user = userRows[0];

    return {
      membershipId: existing.id,
      user: {
        id: detail.userId,
        email: user?.email ?? "",
        displayName: user?.displayName ?? null,
      },
      roleCode: detail.roleCode,
      storeAccessKind: finalKind,
      accessibleStoreIds,
      revokedAt: detail.revokedAt ?? null,
    };
  }
}
