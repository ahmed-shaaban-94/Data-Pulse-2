/**
 * MembershipsService — slice US4 (T173/T174).
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
 *     on DELETE and PATCH methods. Insufficient role → 403 before this runs.
 *
 * Error contract
 * --------------
 *   - 401 (no active tenant)     → TenantContextGuard
 *   - 403 (insufficient role)    → RolesGuard (denyAs: 403)
 *   - 404 (not found / already revoked / cross-tenant) → this service
 *   - 400 (invalid role_code / invalid store_ids / logic conflict) → this service
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import {
  runWithTenantContext,
  type TenantContext,
} from "@data-pulse-2/db";
import { PG_POOL } from "../auth/auth.module";
import type { ResolvedContext } from "../context/types";
import type { MembershipDetail } from "../context/membership.repository";
import type { MembershipUpdateDto } from "./dto";
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

const PLATFORM_ADMIN_CODE = "platform_admin";

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
   * Returns `void` on success; throws `NotFoundException` (→ 404) when the
   * membership is not found, belongs to a different tenant, is already revoked,
   * or is soft-deleted.
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

  /**
   * `PATCH /api/v1/memberships/:membership_id`.
   *
   * Validates the requested changes, then applies them atomically within a
   * single `runWithTenantContext` transaction:
   *   1. Load existing membership (404 if not found/revoked/cross-tenant).
   *   2. If `role_code` provided: look up role_id in tenant; reject
   *      `platform_admin`; unknown code → 400.
   *   3. Resolve effective kind (`body.store_access_kind ?? existing.storeAccessKind`).
   *   4. Validate `store_ids`: required + non-empty for "specific"; must all
   *      belong to active tenant.
   *   5. If `store_ids` provided without `store_access_kind`: only valid when
   *      existing kind is already "specific" (otherwise 400 — ambiguous intent).
   *   6. Apply UPDATE memberships + DELETE/INSERT store_access.
   *   7. Return the updated `MembershipDetail`.
   */
  async update(ctx: ResolvedContext, membershipId: string, dto: MembershipUpdateDto): Promise<MembershipDetail> {
    return this.tx(this.pool, txCtx(ctx), async (client) => {
      const tenantId = ctx.tenantId as string;

      // Step 1: load existing row (404 gate)
      const existing = await this.memberships.findActive(client, membershipId, tenantId);
      if (!existing) throw new NotFoundException("Not Found");

      // Step 2: role validation
      let roleId: string | undefined;
      if (dto.role_code !== undefined) {
        if (dto.role_code === PLATFORM_ADMIN_CODE) {
          throw new BadRequestException("platform_admin is a platform-level role and cannot be assigned to a tenant membership");
        }
        const found = await this.memberships.findRoleId(client, tenantId, dto.role_code);
        if (!found) throw new BadRequestException(`Unknown role_code: ${dto.role_code}`);
        roleId = found;
      }

      // Step 3/5: store_ids without explicit kind change
      if (dto.store_ids !== undefined && dto.store_access_kind === undefined) {
        if (existing.storeAccessKind !== "specific") {
          throw new BadRequestException(
            "store_ids can only be updated without store_access_kind when the existing access kind is 'specific'",
          );
        }
      }

      // Step 4: validate store_ids belong to active tenant
      const effectiveKind = dto.store_access_kind ?? existing.storeAccessKind;
      const storeIds = dto.store_ids;
      if (effectiveKind === "specific" && storeIds && storeIds.length > 0) {
        const invalid = await this.memberships.findInvalidStoreIds(client, tenantId, storeIds);
        if (invalid.length > 0) {
          throw new BadRequestException(`store_ids not found in active tenant: ${invalid.join(", ")}`);
        }
        // Deduplicate (Zod allows duplicates in arrays)
        const deduped = [...new Set(storeIds)];
        if (deduped.length !== storeIds.length) {
          throw new BadRequestException("store_ids must not contain duplicates");
        }
      }

      // Step 6/7: apply and return
      return this.memberships.update(client, existing, {
        roleId,
        storeAccessKind: dto.store_access_kind,
        storeIds: storeIds && storeIds.length > 0 ? [...new Set(storeIds)] : storeIds,
      });
    });
  }
}
