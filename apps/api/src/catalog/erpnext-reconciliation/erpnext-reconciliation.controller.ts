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
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import {
  ListBacklogQuerySchema,
  type ListBacklogQuery,
} from "./dto/list-backlog-query.dto";
import {
  RepairPostingBodySchema,
  type RepairPostingBody,
} from "./dto/repair-request.dto";
import {
  ErpnextReconciliationService,
  RepairNotFoundError,
  type RecordedRepair,
} from "./erpnext-reconciliation.service";
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

  private requireContext(request: TenantContextRequest): {
    tenantId: string;
    userId: string;
  } {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return { tenantId: ctx.tenantId, userId: ctx.userId };
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

  /** POST — repair (re-offer) a posting dead-letter (US2). Idempotent (O-3). */
  @Post("api/v1/catalog/erpnext-reconciliation/postings/:workItemRef/repair")
  @Idempotent("required")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_reconciliation.posting.repaired")
  @HttpCode(201)
  async repairPosting(
    @Req() request: TenantContextRequest,
    @Param("workItemRef", new ParseUUIDPipe()) workItemRef: string,
    @Body(new ZodValidationPipe(RepairPostingBodySchema)) _body: RepairPostingBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecordedRepair> {
    const { tenantId, userId } = this.requireContext(request);
    try {
      const result = await this.service.repairPosting({
        tenantId,
        actorUserId: userId,
        workItemRef,
      });
      if (result.replayed) {
        // Service-level no-op echo (already-terminal/in-flight target) → 200.
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200);
      }
      return result.repair;
    } catch (err) {
      if (err instanceof RepairNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Work item not found." });
      }
      throw err;
    }
  }
}
