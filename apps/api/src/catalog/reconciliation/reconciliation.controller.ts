/**
 * ReconciliationController — 005-WAVE2-LINK-HAPPY (T622).
 *
 * Implements the tenant-admin reconciliation routes defined in:
 *   packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Wave 2 / LINK-HAPPY scope: only the link endpoint. Subsequent Wave 2
 * slices add the create-new (T630) operation.
 *
 * Route:
 *   POST /api/v1/catalog/unknown-items/:id/link
 *   operationId: tenantAdminLinkUnknownItem
 *
 * Request body (LinkUnknownItemRequest, snake_case per OpenAPI):
 *   { product_id: UUID }
 *   additionalProperties: false  — enforced via .strict() on the Zod schema.
 *   Note: tasks.md T622 references "productId" (camelCase) but the OpenAPI
 *   YAML is the source of truth per Constitution §IV; snake_case wins.
 *
 * Auth gap (carried forward from Wave 1 slices):
 *   No @UseGuards(AuthGuard, TenantContextGuard, RolesGuard). The
 *   `apps/api/src/auth/**` surface remains forbidden for 005. The resolved
 *   context is injected by integration tests via ConfigurableContextGuard
 *   and will be wired by a subsequent auth-integration slice. Tracked in
 *   wave-status.md "Outstanding known gap" section.
 *
 * Spec anchors: FR-040, FR-053, FR-080, FR-081, FR-092, SI-001.
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
} from "@nestjs/common";
import { z } from "zod";

import { Auditable } from "../../audit/auditable.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../context/types";
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
}
