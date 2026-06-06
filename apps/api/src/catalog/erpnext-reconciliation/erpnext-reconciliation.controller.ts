/**
 * ErpnextReconciliationController — 017.
 *
 * The human Tenant-Admin reconciliation/repair surface
 * (packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml).
 * Authenticated by the HUMAN `cookieAuth` → `DashboardAuthGuard` (the 007/013/014
 * convention), NOT the 012 `connectorBearer` machine scheme nor the POS `clerkJwt`
 * device scheme (FR-018). `TenantContextGuard` publishes `request.context`;
 * `RolesGuard` + `@Roles` gate the surface (default deny → 404, §II/§XII).
 *
 * Routes (under /api/v1/catalog/erpnext-reconciliation — the 014 namespace):
 *   GET /postings/backlog   listPostingBacklog (US1 🎯)
 *   (repair + run/report routes land in 017-US2 / 017-US3)
 *
 * `tenant_id` resolves server-side from `request.context`, never the query/body
 * (§XII; strict Zod DTOs reject smuggled fields with 400). Every response is a
 * `toBody` projection (no raw DB entity, §IV).
 */
import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import {
  ListBacklogQuerySchema,
  type ListBacklogQuery,
} from "./dto/list-backlog-query.dto";
import { ErpnextReconciliationService } from "./erpnext-reconciliation.service";
import type { PostingBacklogItem } from "./reconciliation-report.projection";

interface PostingBacklogPageResponse {
  readonly items: readonly PostingBacklogItem[];
  readonly nextCursor: string | null;
}

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ErpnextReconciliationController {
  constructor(private readonly service: ErpnextReconciliationService) {}

  private requireTenant(request: TenantContextRequest): string {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return ctx.tenantId;
  }

  /** GET — the tenant's posting dead-letter backlog (US1; a read-projection over 015). */
  @Get("api/v1/catalog/erpnext-reconciliation/postings/backlog")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_reconciliation.backlog.listed")
  async listPostingBacklog(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListBacklogQuerySchema))
    query: ListBacklogQuery,
  ): Promise<PostingBacklogPageResponse> {
    const tenantId = this.requireTenant(request);
    const result = await this.service.listPostingBacklog({
      tenantId,
      cursor: query.cursor != null ? BigInt(query.cursor) : null,
      limit: query.limit ?? 100,
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.class ? { rejectionCategory: query.class } : {}),
    });
    return { items: result.items, nextCursor: result.nextCursor };
  }
}
