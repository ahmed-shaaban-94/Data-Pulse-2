/**
 * ReconciliationController — 005-WAVE2-LINK-HAPPY (T622) +
 *                            005-WAVE2-CREATE-HAPPY (T632).
 *
 * Implements the tenant-admin reconciliation routes defined in:
 *   packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Routes:
 *   POST /api/v1/catalog/unknown-items/:id/link
 *     operationId: tenantAdminLinkUnknownItem
 *   POST /api/v1/catalog/unknown-items/:id/create-product
 *     operationId: tenantAdminCreateProductFromUnknownItem
 *
 * Request bodies (snake_case per OpenAPI — Constitution §IV):
 *   LinkUnknownItemRequest:                   { product_id: UUID }
 *   CreateProductFromUnknownItemRequest:      { name: string,
 *                                               tax_category: string,
 *                                               category_id?: UUID | null }
 *   Both schemas use `additionalProperties: false`; enforced via `.strict()`
 *   on the Zod definitions below. The body-supplied `tenantId` (if any)
 *   is rejected with 400 `validation_error` — Constitution §III. (OpenAPI
 *   prose says `validation_failure`; that is documented drift — the
 *   enforced wire code is `validation_error` / ErrorCodes.VALIDATION.)
 *
 * Authentication & authorization (wired by 005-WAVE2-AUTH-GUARD-WIRING):
 *   Class-level `@UseGuards(DashboardAuthGuard, TenantContextGuard)`
 *   authenticates every request and publishes the resolved tenant
 *   context as `request.context`. Per-method `RolesGuard` + `@Roles`
 *   gate writes:
 *
 *     - POST link            → @Roles("owner","tenant_admin","store_manager")  // denyAs: 404
 *     - POST create-product  → @Roles("owner","tenant_admin")                  // denyAs: 404
 *
 *   Both are state changes against an existing `:id` (an unknown
 *   item the caller may or may not have access to); per FR-013 /
 *   FR-092 / SI-001, a wrong-role caller MUST NOT be able to
 *   distinguish "you exist but lack permission" from "this item
 *   does not exist", so the default `denyAs: 404` shape is correct.
 *   Integration tests `.overrideGuard()` these three guards with
 *   no-op passthroughs and continue to inject context via the
 *   global ConfigurableContextGuard registered on the test app.
 *
 * Audit subjects (no dual-emission — tasks.md L477):
 *   link        → @Auditable("unknown_item.resolved.linked")
 *   create      → @Auditable("unknown_item.resolved.created")
 *   The service owns raw `INSERT INTO tenant_products` SQL on the create
 *   path; it does NOT call TenantCatalogService.create (which would
 *   emit a second `catalog.product.create` audit row in the same
 *   transaction).
 *
 * Spec anchors: FR-040, FR-053, FR-060, FR-061, FR-062, FR-063, FR-080,
 *               FR-081, FR-092, SI-001, Constitution §III, §IV.
 */
import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import {
  CreateProductFromUnknownItemRequestSchema,
  type CreateProductFromUnknownItemRequestDto,
} from "./dto/create-product-request.dto";
import { ReconciliationService, type UnknownItemRow } from "./reconciliation.service";

// ---------------------------------------------------------------------------
// Request DTO + Zod schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for `tenantAdminLinkUnknownItem` request body.
 * Mirrors OpenAPI `LinkUnknownItemRequest`:
 *   required: [product_id]
 *   additionalProperties: false
 */
const LinkUnknownItemRequestSchema = z
  .object({
    product_id: z.string().uuid(),
  })
  .strict();

type LinkUnknownItemRequestDto = z.infer<typeof LinkUnknownItemRequestSchema>;

// The CreateProductFromUnknownItemRequest schema lives in
// ./dto/create-product-request.dto.ts (T636) so the request contract has a
// single named home. Imported above.

// ---------------------------------------------------------------------------
// Wire shape (snake_case, matches OpenAPI UnknownItem schema)
// ---------------------------------------------------------------------------

interface UnknownItemWireShape {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly identifier_type: string;
  readonly identifier_value: string;
  readonly source_system: string | null;
  readonly resolution_status: "pending" | "resolved" | "dismissed";
  readonly resolution_action: "linked" | "created" | "dismissed" | null;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly resolved_product_id: string | null;
  readonly encountered_at: string;
  readonly sale_context: Record<string, unknown> | null;
}

function rowToWireShape(row: UnknownItemRow): UnknownItemWireShape {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    store_id: row.storeId,
    identifier_type: row.identifierType,
    identifier_value: row.identifierValue,
    source_system: row.sourceSystem,
    resolution_status: row.resolutionStatus,
    resolution_action: row.resolutionAction,
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolved_by: row.resolvedBy,
    resolved_product_id: row.resolvedProductId,
    encountered_at: row.encounteredAt.toISOString(),
    sale_context: row.saleContext,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  /**
   * POST /api/v1/catalog/unknown-items/:id/link
   *
   * Links a pending unknown item to an existing, active tenant product.
   * On success: 200 OK + resolved UnknownItem shape.
   * On error:
   *   400 validation_error  — malformed :id or invalid body
   *   401 Unauthorized      — missing resolved context
   *   404 Not Found         — unknown item or product not found (SI-001:
   *                           non-disclosing, does not distinguish the two)
   *   409 alias_conflict    — product_aliases unique index violated (FR-040)
   *   409 already_reconciled — item already resolved or dismissed (FR-004)
   *   409 target_unavailable — target product is retired (FR-051)
   */
  @Post("api/v1/catalog/unknown-items/:id/link")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  // Per spec.md US2 #5 + tasks.md T622: tenant-admin OR store-manager
  // (scoped to the item's store via RLS) can link. The store_manager role
  // is intentional — store-scoped operators reconcile within their store.
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("unknown_item.resolved.linked")
  async tenantAdminLinkUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(LinkUnknownItemRequestSchema))
    body: LinkUnknownItemRequestDto,
  ): Promise<UnknownItemWireShape> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.reconciliationService.linkUnknownItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      unknownItemId: id,
      productId: body.product_id,
      actorUserId: ctx.userId,
    });

    if (result.kind === "ok") {
      return rowToWireShape(result.row);
    }

    if (result.kind === "alias_conflict") {
      throw new ConflictException({
        code: "alias_conflict",
        message:
          "A product alias with this identifier already exists for the target product. " +
          "Linking would violate the unique alias constraint (FR-040).",
      });
    }

    if (result.kind === "already_reconciled") {
      throw new ConflictException({
        code: "already_reconciled",
        message:
          "The unknown item is already resolved or dismissed; lifecycle transitions are monotonic per FR-004.",
      });
    }

    if (result.kind === "target_unavailable") {
      throw new ConflictException({
        code: "target_unavailable",
        message:
          "The target product is retired and cannot accept new alias links (FR-051).",
      });
    }

    // SI-001 / FR-092: non-disclosing 404 — does not reveal whether the
    // unknown item was absent or the product was absent. Retired products
    // are handled by the `target_unavailable` branch above (409); this
    // fallthrough represents truly absent items (RLS-filtered cross-tenant
    // or fabricated UUID).
    throw new NotFoundException("Not Found");
  }

  /**
   * POST /api/v1/catalog/unknown-items/:id/create-product
   *
   * Creates a brand-new tenant product directly from a pending unknown
   * item. Server-resolved tenant_id (Constitution §III); body-supplied
   * tenantId is rejected with 400 validation_error by the `.strict()`
   * Zod schema.
   *
   * On success: 201 Created + updated UnknownItem shape (resolution_status
   *   = 'resolved', resolution_action = 'created', resolved_product_id
   *   pointing at the new tenant_products row).
   * On error:
   *   400 validation_error     — malformed :id, missing name / tax_category,
   *                              or body smuggling an additional property
   *   401 Unauthorized         — missing resolved context
   *   404 Not Found            — unknown item absent (non-disclosing per
   *                              SI-001 / FR-092)
   *   409 alias_conflict       — product_aliases unique index violated
   *                              (FR-062); the would-be new product is
   *                              NOT created (transaction rollback)
   *   409 already_reconciled   — item already resolved/dismissed (FR-004)
   */
  @Post("api/v1/catalog/unknown-items/:id/create-product")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("unknown_item.resolved.created")
  async tenantAdminCreateProductFromUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(CreateProductFromUnknownItemRequestSchema))
    body: CreateProductFromUnknownItemRequestDto,
  ): Promise<UnknownItemWireShape> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.reconciliationService.createProductFromUnknownItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      unknownItemId: id,
      actorUserId: ctx.userId,
      // The Zod schema already trims; the .min(1) check guarantees the
      // trimmed string is non-empty.
      name: body.name.trim(),
      taxCategory: body.tax_category.trim(),
      categoryId: body.category_id ?? null,
    });

    if (result.kind === "ok") {
      return rowToWireShape(result.row);
    }

    if (result.kind === "alias_conflict") {
      throw new ConflictException({
        code: "alias_conflict",
        message:
          "A product alias with this identifier already exists for a different product. " +
          "Creating would violate the unique alias constraint (FR-062).",
      });
    }

    if (result.kind === "already_reconciled") {
      throw new ConflictException({
        code: "already_reconciled",
        message:
          "The unknown item is already resolved or dismissed; lifecycle transitions are monotonic per FR-004.",
      });
    }

    // SI-001 / FR-092: non-disclosing 404 — RLS-filtered cross-tenant
    // or fabricated UUID.
    throw new NotFoundException("Not Found");
  }
}
