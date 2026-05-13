/**
 * StoresController — slice US2 (T134).
 *
 * Implements the five endpoints in
 * `specs/001-foundation-auth-tenant-store/contracts/stores.openapi.yaml`:
 *
 *     GET    /api/v1/stores              listStores
 *     POST   /api/v1/stores              createStore       [owner|tenant_admin]
 *     GET    /api/v1/stores/{store_id}   readStore         (per access policy)
 *     PATCH  /api/v1/stores/{store_id}   updateStore       [owner|tenant_admin]
 *     DELETE /api/v1/stores/{store_id}   softDeleteStore   [owner|tenant_admin]
 *
 * Why this controller IS guarded by `TenantContextGuard`
 * ------------------------------------------------------
 * Every store route is scoped to an **active tenant** (the contract's
 * "Active tenant must be set on the session/token; otherwise 401").
 * The TenantContextGuard:
 *
 *   1. Resolves the active tenant from the principal's session or
 *      token binding.
 *   2. Validates the caller still has an active membership in that
 *      tenant (or is a platform admin).
 *   3. Publishes the resolved context as `request.context`.
 *
 * Compare with `TenantsController`, which is path-as-context (`/:id`
 * IS the tenant) and intentionally does NOT mount this guard.
 *
 * Authorization
 * -------------
 * Class-level guards authenticate every request. Per-method
 * `RolesGuard` + `@Roles` decorators gate write operations:
 *
 *   - POST  → @Roles("owner","tenant_admin", { denyAs: 403 })
 *             insufficient role within an already-resolved active
 *             tenant is NOT a secret — 403 is the right shape.
 *
 *   - PATCH → @Roles("owner","tenant_admin")  // default denyAs: 404
 *   - DELETE → @Roles("owner","tenant_admin")  // default denyAs: 404
 *             For these, FR-ISO-4 says a wrong-role caller must NOT be
 *             able to distinguish "you exist but lack permission" from
 *             "the store doesn't exist" — both rejected paths look
 *             like 404 from outside.
 *
 * GET routes carry no role decorator. Visibility is data-shaped:
 * `list` shows every store in the active tenant; `read` further
 * applies the `kind='specific'` store-access policy via
 * `MembershipRepository.canAccessStore` inside `StoresService`.
 *
 * Cross-cutting policies (consistent with prior controllers)
 * ---------------------------------------------------------
 *   - Bodies validated by `ZodValidationPipe`. `.strict()` rejects
 *     unknown keys (FR-STORE-4: `tenant_id` on PATCH → 400).
 *   - Exceptions pass through `GlobalExceptionFilter` to the canonical
 *     envelope.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  StoreCreateSchema,
  StoreUpdateSchema,
  type StoreCreateInput,
  type StoreUpdateInput,
} from "./dto";
import type { StoreRecord } from "./stores.repository";
import { StoresService } from "./stores.service";

/** Snake-case wire-shape matching the OpenAPI `Store` schema. */
interface StoreBody {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toBody(record: StoreRecord): StoreBody {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    code: record.code,
    name: record.name,
    is_active: record.isActive,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    deleted_at: record.deletedAt ? record.deletedAt.toISOString() : null,
  };
}

@Controller("api/v1/stores")
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get()
  async list(@Req() request: TenantContextRequest): Promise<StoreBody[]> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const records = await this.storesService.list(ctx);
    return records.map(toBody);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  async create(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(StoreCreateSchema)) body: StoreCreateInput,
  ): Promise<StoreBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const record = await this.storesService.create(ctx, body);
    return toBody(record);
  }

  @Get(":store_id")
  async read(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
  ): Promise<StoreBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const record = await this.storesService.read(ctx, storeId);
    return toBody(record);
  }

  @Patch(":store_id")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async update(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
    @Body(new ZodValidationPipe(StoreUpdateSchema)) body: StoreUpdateInput,
  ): Promise<StoreBody> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const record = await this.storesService.update(ctx, storeId, body);
    return toBody(record);
  }

  @Delete(":store_id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async softDelete(
    @Req() request: TenantContextRequest,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
  ): Promise<void> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    await this.storesService.softDelete(ctx, storeId);
  }
}
