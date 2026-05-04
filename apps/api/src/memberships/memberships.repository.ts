import { Injectable } from "@nestjs/common";
import { memberships } from "@data-pulse-2/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import type { PoolClient } from "pg";

@Injectable()
export class MembershipsRepository {
  /**
   * Revoke the membership identified by `membershipId` within `tenantId`.
   *
   * The UPDATE runs inside a `runWithTenantContext`-scoped `PoolClient`,
   * so the `memberships_tenant_isolation` RLS policy is satisfied.
   * Four conditions ensure correctness:
   *   - `id = membershipId`         — target the right row
   *   - `tenant_id = tenantId`      — double-check tenant (belt + suspenders on top of RLS)
   *   - `revoked_at IS NULL`        — not already revoked
   *   - `deleted_at IS NULL`        — not soft-deleted
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
}
