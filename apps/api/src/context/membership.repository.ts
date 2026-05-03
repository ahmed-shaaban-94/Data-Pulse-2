/**
 * MembershipRepository — slice 9 (T151).
 *
 * Focused query helper for `TenantContextGuard`. Answers exactly the
 * three questions the guard needs:
 *
 *   1. Is the caller a platform admin?
 *      (`users.is_platform_admin = true`)
 *   2. Does this user have an active membership in this tenant?
 *      (returns the membership's `storeAccessKind`, or `null` if no
 *      active membership exists)
 *   3. For a `'specific'` membership, can this user access this store
 *      WITHIN the active tenant?
 *      (`store_access` row exists AND store is in the tenant)
 *      For an `'all'` membership: the store must merely belong to the
 *      active tenant.
 *
 * Why a separate repository (not inline in the guard)
 * ---------------------------------------------------
 *   - Mirrors the established pattern (`SessionRepository`,
 *     `AuthTokenRepository`) — every other repository in this codebase
 *     lives in its module's folder, takes a `pg.Pool`, exposes typed
 *     methods.
 *   - Keeps the guard focused on policy. Tests for the guard fake the
 *     repository at the class boundary and never touch SQL.
 *   - When membership lookups grow (Redis caching for FR-AUTH-6's
 *     ≤5min revocation propagation, e.g.), the changes land here
 *     without rippling through guard tests.
 *
 * RLS posture
 * -----------
 * The guard's own queries run on a plain `pg.Pool` connection without
 * `runWithTenantContext`. Same posture as `SessionRepository` and
 * `AuthTokenRepository` — these tables are accessed by the auth/context
 * stack BEFORE a tenant context is established (chicken-and-egg). The
 * RLS policies on `memberships` and `store_access` are still in force
 * for normal application traffic; this is the deliberately scoped
 * exception, gated behind the guard's narrow query surface.
 */
import { Injectable } from "@nestjs/common";
import {
  memberships,
  storeAccess,
  stores,
  users,
  type StoreAccessKind,
} from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";

/**
 * Active membership snapshot returned by `findActiveMembership`. We
 * deliberately do NOT return the entire `memberships` row — the guard
 * only needs the access-kind to decide which store-validation branch
 * to take.
 */
export interface ActiveMembership {
  readonly membershipId: string;
  readonly storeAccessKind: StoreAccessKind;
}

@Injectable()
export class MembershipRepository {
  private readonly db: NodePgDatabase;

  constructor(pool: Pool) {
    this.db = drizzle(pool);
  }

  /**
   * Return `true` iff the user exists, is not soft-deleted, and is
   * marked as a platform admin.
   *
   * Used by the guard to bypass per-tenant membership validation for
   * platform admins (FR-TEN-6).
   */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ isPlatformAdmin: users.isPlatformAdmin })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return rows[0]?.isPlatformAdmin ?? false;
  }

  /**
   * Return the user's active membership in `tenantId`, or `null` if
   * none exists. "Active" means:
   *   - membership row exists,
   *   - `revoked_at IS NULL`,
   *   - `deleted_at IS NULL`.
   *
   * Callers translate `null` into a 404 (not 403) per FR-ISO-4 — the
   * absence of a membership must look identical to "tenant doesn't
   * exist" from outside the system.
   */
  async findActiveMembership(
    userId: string,
    tenantId: string,
  ): Promise<ActiveMembership | null> {
    const rows = await this.db
      .select({
        membershipId: memberships.id,
        storeAccessKind: memberships.storeAccessKind,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, tenantId),
          isNull(memberships.revokedAt),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      membershipId: row.membershipId,
      storeAccessKind: row.storeAccessKind as StoreAccessKind,
    };
  }

  /**
   * Returns true iff `storeId` is reachable from `(membershipId, tenantId)`
   * given the supplied access kind:
   *   - `'all'`  → store exists, is not soft-deleted, and belongs to the
   *                active tenant.
   *   - `'specific'` → all of the above AND a `store_access` row exists
   *                    for `(membershipId, storeId, tenantId)`.
   *
   * `false` is the cross-tenant / cross-store leak rejection signal;
   * the guard translates it into a 404 per FR-ISO-4.
   */
  async canAccessStore(
    membershipId: string,
    tenantId: string,
    storeId: string,
    kind: StoreAccessKind,
  ): Promise<boolean> {
    // Step 1: confirm the store belongs to this tenant (and exists).
    const storeRows = await this.db
      .select({ id: stores.id })
      .from(stores)
      .where(
        and(
          eq(stores.id, storeId),
          eq(stores.tenantId, tenantId),
          isNull(stores.deletedAt),
        ),
      )
      .limit(1);
    if (!storeRows[0]) return false;
    if (kind === "all") return true;

    // Step 2 (only for 'specific'): require a store_access grant.
    const grantRows = await this.db
      .select({ membershipId: storeAccess.membershipId })
      .from(storeAccess)
      .where(
        and(
          eq(storeAccess.membershipId, membershipId),
          eq(storeAccess.storeId, storeId),
          eq(storeAccess.tenantId, tenantId),
        ),
      )
      .limit(1);
    return grantRows.length > 0;
  }
}
