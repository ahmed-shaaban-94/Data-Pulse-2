/**
 * InventoryController — 009-US1-ONHAND (T033).
 *
 * The first runtime routes of the Inventory domain — the two READ operations
 * from the contract (packages/contracts/openapi/inventory/inventory.yaml):
 *
 *   GET /api/inventory/v1/on-hand/{storeId}/{productId}   → getOnHand
 *   GET /api/inventory/v1/stores/{storeId}/movements      → listStockMovements
 *
 * Auth: class-level `@UseGuards(DashboardAuthGuard, TenantContextGuard)` — the
 * cookieAuth operator surface (plan §4.2), NOT a POS-device route. The guards
 * authenticate and publish the resolved tenant context as `request.context`.
 * Tenant resolves from context (never from path/body for write-authority);
 * `storeId` is the path-scoped SELECTION target, authorized object-level
 * against the principal's resolved store: a request for a store outside the
 * caller's scope is a non-disclosing 404 (FR-051, §II/§XII).
 *
 * Write operations (createStockMovement / transfer / count) are authored in
 * 009-US2-MANUAL onward — NOT here.
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { ResolvedContext, TenantContextRequest } from "../context/types";
import {
  InventoryService,
  type OnHandBody,
  type StockMovementListBody,
} from "./inventory.service";

const UuidSchema = z.string().uuid();
const LimitSchema = z.coerce.number().int().min(1).max(200).optional();
const OptionalUuidSchema = z.string().uuid().optional();

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * GET /api/inventory/v1/on-hand/{storeId}/{productId}
   *
   * The derived (compute-on-read) on-hand for a (store, product). Empty key ⇒
   * deterministic zero (FR-005); negative ⇒ negativeBalance=true (FR-024).
   */
  @Get("api/inventory/v1/on-hand/:storeId/:productId")
  async getOnHand(
    @Req() request: TenantContextRequest,
    @Param("storeId", new ZodValidationPipe(UuidSchema)) storeId: string,
    @Param("productId", new ZodValidationPipe(UuidSchema)) productId: string,
  ): Promise<OnHandBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.getOnHand({
      tenantId: ctx.tenantId as string,
      storeId,
      productId,
    });
  }

  /**
   * GET /api/inventory/v1/stores/{storeId}/movements
   *
   * Movements for a (store) in stable order (FR-004). `productId` set ⇒ that
   * product; omitted ⇒ ad-hoc (NULL-product) movements only (contract).
   */
  @Get("api/inventory/v1/stores/:storeId/movements")
  async listStockMovements(
    @Req() request: TenantContextRequest,
    @Param("storeId", new ZodValidationPipe(UuidSchema)) storeId: string,
    @Query("productId", new ZodValidationPipe(OptionalUuidSchema))
    productId: string | undefined,
    @Query("limit", new ZodValidationPipe(LimitSchema)) limit: number | undefined,
  ): Promise<StockMovementListBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.listStockMovements({
      tenantId: ctx.tenantId as string,
      storeId,
      productId: productId ?? null,
      limit,
    });
  }

  /** Resolve + assert an authenticated, tenant-bound principal. */
  private requireContext(request: TenantContextRequest): ResolvedContext {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return ctx;
  }

  /**
   * Object-level store authorization (§XII). A store-scoped principal
   * (`ctx.storeId` set) may only address its own store; a request for any
   * other store is a NON-DISCLOSING 404 (FR-051) — never 403, which would leak
   * existence. A tenant-level principal (`ctx.storeId === null`, e.g. a
   * tenant-wide admin) may address any store within its tenant (RLS still
   * scopes the rows to the tenant).
   */
  private authorizeStore(ctx: ResolvedContext, storeId: string): void {
    if (ctx.storeId !== null && ctx.storeId !== storeId) {
      throw new NotFoundException("Not Found");
    }
  }
}
