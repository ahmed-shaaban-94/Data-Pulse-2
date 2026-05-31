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
 * Write path (009-US2-MANUAL, T044):
 *   POST /api/inventory/v1/stores/{storeId}/movements → createStockMovement
 * The store is the PATH parameter; tenant + actor resolve from `request.context`
 * server-side. The body is a STRICT Zod DTO (`.strict()`) — any `tenantId` /
 * `storeId` / `createdBy` / `receivedAt` / derived-balance key is rejected 400
 * (mass-assignment ban, FR-052/§XII). NO `@Auditable` decorator on the route:
 * the service writes the audit row in-transaction, and a route-level
 * `@Auditable` would persist a SECOND row for one action (the dual-audit trap
 * the catalog service warns about).
 *
 * Transfer / count operations are authored in 009-US5 / US6 — NOT here.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard } from '../auth/dashboard-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TenantContextGuard } from '../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../context/types';
import {
  InventoryService,
  type OnHandBody,
  type StockMovementBody,
  type StockMovementListBody,
} from './inventory.service';

const UuidSchema = z.string().uuid();
const LimitSchema = z.coerce.number().int().min(1).max(200).optional();
const OptionalUuidSchema = z.string().uuid().optional();

/**
 * Strict create-movement command (contract `CreateStockMovementCommand`,
 * `additionalProperties: false`). `.strict()` rejects any unknown key — which
 * is how the mass-assignment ban (FR-052) is enforced at the boundary: a body
 * `tenantId` / `storeId` / `createdBy` / `receivedAt` / `negativeBalance` is an
 * unknown key here and 400s. `quantity` is a signed decimal string preserved
 * verbatim (no float coercion). Nullable provenance refs are accepted as
 * provenance only.
 */
const DecimalQtySchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'quantity must be a signed decimal string');
const CreateStockMovementSchema = z
  .object({
    movementType: z.enum(['inbound', 'outbound', 'adjustment']),
    quantity: DecimalQtySchema,
    stockingUnit: z.string().min(1).max(32),
    tenantProductRef: z.string().uuid().nullable().optional(),
    reason: z.string().max(500).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    saleId: z.string().uuid().nullable().optional(),
    saleLineId: z.string().uuid().nullable().optional(),
    terminalEventRef: z.string().uuid().nullable().optional(),
  })
  .strict();
type CreateStockMovementDto = z.infer<typeof CreateStockMovementSchema>;

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
  @Get('api/inventory/v1/on-hand/:storeId/:productId')
  async getOnHand(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Param('productId', new ZodValidationPipe(UuidSchema)) productId: string,
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
  @Get('api/inventory/v1/stores/:storeId/movements')
  async listStockMovements(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Query('productId', new ZodValidationPipe(OptionalUuidSchema))
    productId: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number | undefined,
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

  /**
   * POST /api/inventory/v1/stores/{storeId}/movements
   *
   * Append a manual movement (inbound / outbound / adjustment; write-off is a
   * reason-coded outbound). Tenant + actor come from the resolved context, the
   * store from the path — never the body (FR-052). A cross-unit movement is a
   * 400 (CrossUnitError, surfaced by the global filter). On-hand MAY go
   * negative (allow-and-flag, FR-024) — never rejected.
   */
  @Post('api/inventory/v1/stores/:storeId/movements')
  @HttpCode(HttpStatus.CREATED)
  async createStockMovement(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Body(new ZodValidationPipe(CreateStockMovementSchema))
    body: CreateStockMovementDto,
  ): Promise<StockMovementBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.createStockMovement({
      tenantId: ctx.tenantId as string,
      storeId,
      userId: ctx.userId as string,
      movementType: body.movementType,
      quantity: body.quantity,
      stockingUnit: body.stockingUnit,
      tenantProductRef: body.tenantProductRef ?? null,
      reason: body.reason ?? null,
      occurredAt: body.occurredAt ?? null,
      saleId: body.saleId ?? null,
      saleLineId: body.saleLineId ?? null,
      terminalEventRef: body.terminalEventRef ?? null,
    });
  }

  /** Resolve + assert an authenticated, tenant-bound principal. */
  private requireContext(request: TenantContextRequest): ResolvedContext {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException('Unauthorized');
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
      throw new NotFoundException('Not Found');
    }
  }
}
