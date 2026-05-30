/**
 * SalesController — 008 US1 capture (T035).
 *
 * Implements the `captureSale` (+ `readSale`) operationIds from
 * `packages/contracts/openapi/pos-sales/sales.yaml`:
 *   POST /api/pos/v1/sales            → captureSale
 *   GET  /api/pos/v1/sales/{saleRef}  → readSale
 *
 * Auth / context: mirrors `posCaptureItem` — `@UseGuards(PosOperatorAuthGuard,
 * TenantContextGuard)` resolve the POS principal onto `req.context`; the
 * tenant/store/actor come from there and are NEVER read from the body
 * (FR-061). Body strictness (FR-062) is enforced by the `.strict()` Zod DTO.
 *
 * Idempotency: `@Idempotent("required")` engages the existing global
 * IdempotencyInterceptor (FR-051) — no new primitive. Provenance dedup
 * (FR-050) is enforced independently in the service, so a re-delivery with a
 * different Idempotency-Key still resolves to the same sale.
 *
 * Audit: `@Auditable("sale.captured")` is passive metadata read by the global
 * AuditEmitterInterceptor (FR-090).
 *
 * Status: 201 for a fresh capture; 200 with `Idempotent-Replayed: true` for a
 * provenance dedup-hit (deterministic, identical body — FR-100).
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { Auditable } from "../../audit/auditable.decorator";
import { PosOperatorAuthGuard } from "../../auth/pos-operator-auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  CaptureSaleRequestSchema,
  type CaptureSaleRequestDto,
} from "./dto/capture-sale-request.dto";
import {
  RecordVoidRequestSchema,
  type RecordVoidRequestDto,
} from "./dto/record-void-request.dto";
import {
  SalesService,
  SaleNotFoundError,
  TerminalEventProvenanceConflictError,
  type SaleProjection,
  type TerminalEventProjection,
} from "./sales.service";

/** Canonical UUID shape (any version) — a saleRef that fails this never hits the DB. */
const SALE_REF_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller()
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post("api/pos/v1/sales")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Idempotent("required")
  @Auditable("sale.captured")
  async captureSale(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(CaptureSaleRequestSchema))
    body: CaptureSaleRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // A POS sale MUST resolve a store binding (FR-001).
      throw new UnauthorizedException("store_context_required");
    }

    const result = await this.salesService.captureSale({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      body,
    });

    if (result.created) {
      res.status(HttpStatus.CREATED);
    } else {
      // Provenance dedup-hit: deterministic replay, identical body (FR-100).
      res.status(HttpStatus.OK);
      res.setHeader("Idempotent-Replayed", "true");
    }
    return result.projection;
  }

  @Get("api/pos/v1/sales/:saleRef")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  async readSale(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<SaleProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // Reads are store-scoped: a POS principal may only read sales captured
      // within its own store (spec §120/§449, FR-063). Mirrors captureSale.
      throw new UnauthorizedException("store_context_required");
    }
    if (!SALE_REF_RE.test(saleRef)) {
      // Non-disclosing input guard: a malformed ref must not reach the DB (an
      // invalid uuid would surface as a 500). Treat it as a safe-404.
      throw new NotFoundException("not_found");
    }
    try {
      return await this.salesService.readSaleProjection(
        ctx.tenantId,
        ctx.storeId,
        saleRef,
      );
    } catch (err) {
      if (err instanceof SaleNotFoundError) {
        // Non-disclosing 404 — cross-tenant / cross-store / absent are
        // indistinguishable (FR-063/102, SI-004).
        throw new NotFoundException("not_found");
      }
      throw err;
    }
  }

  @Post("api/pos/v1/sales/:saleRef/void")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Idempotent("required")
  @Auditable("sale.voided")
  async recordVoid(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordVoidRequestSchema))
    body: RecordVoidRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TerminalEventProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (!SALE_REF_RE.test(saleRef)) {
      // A malformed ref is a non-disclosing safe-404, never a 500 (SI-004).
      throw new NotFoundException("not_found");
    }
    try {
      const result = await this.salesService.recordVoid({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance dedup-hit: deterministic replay, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      return result.projection;
    } catch (err) {
      if (err instanceof SaleNotFoundError) {
        // Cross-tenant / cross-store / unknown sale are indistinguishable.
        throw new NotFoundException("not_found");
      }
      if (err instanceof TerminalEventProvenanceConflictError) {
        // Void provenance reused for a different sale → 409 (FR-013).
        throw new ConflictException("conflict");
      }
      throw err;
    }
  }
}
