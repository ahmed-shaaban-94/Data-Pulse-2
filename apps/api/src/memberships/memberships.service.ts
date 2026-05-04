/**
 * MembershipsService — slice US4 (T174).
 *
 * Active-tenant context (NOT path-as-context)
 * -------------------------------------------
 * Tenant id comes from `ResolvedContext.tenantId`, populated by
 * `TenantContextGuard` before this service is reached. The service
 * never reads the membership's `tenant_id` from the URL path.
 *
 * Authorization layering
 * ----------------------
 *   - Authentication: `AuthGuard` (controller class-level).
 *   - Active tenant: `TenantContextGuard` (controller class-level) —
 *     missing active tenant → 401 before this service runs.
 *   - Role gating: `RolesGuard` + `@Roles("owner","tenant_admin",{denyAs:403})`
 *     on the DELETE method. Insufficient role → 403 before this runs.
 *
 * Error contract
 * --------------
 *   - 401 (no active tenant)     → TenantContextGuard
 *   - 403 (insufficient role)    → RolesGuard (denyAs: 403)
 *   - 404 (not found / already revoked / cross-tenant) → this service
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import {
  runWithTenantContext,
  type TenantContext,
} from "@data-pulse-2/db";
import { PG_POOL } from "../auth/auth.module";
import type { ResolvedContext } from "../context/types";
import { MembershipsRepository } from "./memberships.repository";

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

@Injectable()
export class MembershipsService {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly memberships: MembershipsRepository,
    tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  /**
   * `DELETE /api/v1/memberships/:membership_id`.
   *
   * Revokes the membership, which prevents the user from switching to
   * this tenant context in future requests. The action is non-reversible
   * via the API (no un-revoke endpoint in this version).
   *
   * Returns `void` on success; throws `NotFoundException` (→ 404) when:
   *   - the membership_id belongs to a different tenant (RLS filters it)
   *   - the membership_id does not exist at all
   *   - the membership was already revoked
   *   - the membership was soft-deleted
   *
   * `tenantId` is guaranteed non-null by the time this is called because
   * `TenantContextGuard` rejected the request earlier if no active
   * tenant was set.
   */
  async revoke(ctx: ResolvedContext, membershipId: string): Promise<void> {
    await this.tx(this.pool, txCtx(ctx), async (client) => {
      const updated = await this.memberships.revoke(
        client,
        membershipId,
        ctx.tenantId as string,
      );
      if (!updated) throw new NotFoundException("Not Found");
    });
  }
}
