/**
 * UnknownItemsController — 005 Wave 1 / T512 (CAPTURE-HAPPY).
 *
 * Implements the `posCaptureItem` operationId defined in
 * `packages/contracts/openapi/catalog/unknown-items.yaml`:
 *   POST /api/pos/v1/catalog/unknown-items
 *
 * Wave 1 / CAPTURE-HAPPY scope: only the capture endpoint. The `list`
 * (T524) and `dismiss` (T541) operations live in separate downstream
 * slices and will be added to this controller then.
 *
 * Auth / context:
 *   This slice does NOT introduce a new auth guard. The
 *   `req.context: ResolvedContext` shape from 001 is consumed —
 *   integration tests stand up a configurable context guard, and
 *   subsequent slices (or a 002 wiring slice) will mount the real POS
 *   principal resolution onto this route. Per the slice brief, auth
 *   files under `apps/api/src/auth/` are forbidden surface for 005.
 *
 * Idempotency:
 *   `@Idempotent("required")` engages the existing global
 *   `IdempotencyInterceptor` (registered as `APP_INTERCEPTOR` in
 *   `IdempotencyModule`). The interceptor handles the header
 *   (`Idempotency-Key`), per-device scoping (FR-021a — via
 *   `clientId = req.context.userId`), 72h TTL (FR-021b), and
 *   payload-mismatch 409s (FR-021c). T505 (PR #306) proved the
 *   primitive's coverage; we do not re-author it here.
 *
 * Audit:
 *   `@Auditable("unknown_item.captured")` is passive metadata read
 *   by the global `AuditEmitterInterceptor` from `AuditModule`. The
 *   interceptor emits one audit-event per successful response. Deep
 *   audit-event assertion lives in T546.
 *
 * Validation:
 *   The Zod schema in `./dto/capture-request.dto.ts` is the boundary
 *   for FR-070 / FR-071. CAPTURE-HAPPY ships a minimal schema covering
 *   the happy-path fields; T520 (005-WAVE1-VALIDATION) tightens it.
 *
 * Status code:
 *   201 Created for the `unknown` outcome (a new pending row). The
 *   resolved-200 path lands in CAPTURE-RESOLVE (T514).
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { Auditable } from "../../audit/auditable.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  UnknownItemsService,
  type CapturedUnknownItemRow,
} from "./unknown-items.service";

/**
 * Minimal Zod schema mirroring the OpenAPI `PosCaptureItemRequest`.
 * Closed object (`additionalProperties: false` ⇒ `.strict()`).
 *
 * CAPTURE-HAPPY ships the structural validation; full FR-071 enforcement
 * (`source_system` ⇔ `external_pos_id` cross-field constraint, raw-value
 * log redaction) is tightened in 005-WAVE1-VALIDATION (T520).
 */
const PosCaptureItemRequestSchema = z
  .object({
    identifier_type: z.enum([
      "barcode",
      "sku",
      "plu",
      "supplier_code",
      "external_pos_id",
    ]),
    identifier_value: z.string().min(1).max(200),
    source_system: z.string().min(1).max(64).nullable().optional(),
    sale_context: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export type PosCaptureItemRequestDto = z.infer<
  typeof PosCaptureItemRequestSchema
>;

/**
 * Wire shape of the contract's `PosCaptureUnknownResponse`. Adapts the
 * service's `CapturedUnknownItemRow` (camelCase) to the contract's
 * snake_case `UnknownItem`.
 */
interface PosCaptureUnknownResponseBody {
  readonly kind: "unknown";
  readonly unknown_item: {
    readonly id: string;
    readonly tenant_id: string;
    readonly store_id: string;
    readonly identifier_type: string;
    readonly identifier_value: string;
    readonly source_system: string | null;
    readonly resolution_status: "pending";
    readonly resolution_action: null;
    readonly resolved_at: null;
    readonly resolved_by: null;
    readonly resolved_product_id: null;
    readonly encountered_at: string;
    readonly sale_context: Record<string, unknown> | null;
  };
}

function toWireShape(row: CapturedUnknownItemRow): PosCaptureUnknownResponseBody {
  return {
    kind: "unknown",
    unknown_item: {
      id: row.id,
      tenant_id: row.tenantId,
      store_id: row.storeId,
      identifier_type: row.identifierType,
      identifier_value: row.identifierValue,
      source_system: row.sourceSystem,
      resolution_status: row.resolutionStatus,
      resolution_action: row.resolutionAction,
      resolved_at: row.resolvedAt,
      resolved_by: row.resolvedBy,
      resolved_product_id: row.resolvedProductId,
      encountered_at: row.encounteredAt.toISOString(),
      sale_context: row.saleContext,
    },
  };
}

@Controller("api/pos/v1/catalog/unknown-items")
export class UnknownItemsController {
  constructor(private readonly unknownItemsService: UnknownItemsService) {}

  /**
   * `posCaptureItem` — POS submits an item reference.
   *
   * CAPTURE-HAPPY behavior: every submission produces a new pending
   * row. Alias-resolution, store-scope, and natural-dedup are layered
   * in by downstream slices (CAPTURE-RESOLVE / CAPTURE-STORE-SCOPE /
   * CAPTURE-DEDUP).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent("required")
  @Auditable("unknown_item.captured")
  async posCaptureItem(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(PosCaptureItemRequestSchema))
    body: PosCaptureItemRequestDto,
  ): Promise<PosCaptureUnknownResponseBody> {
    const ctx = request.context;
    if (!ctx) {
      // No resolved POS principal context. In production this is
      // unreachable when an auth guard is mounted; in tests the
      // configurable guard sets it. Mirrors `InvitationsController`.
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // FR-011: a POS principal MUST resolve a store binding. Returning
      // 400 here would be a deterministic outcome; the broader FR-070
      // / FR-071 validation taxonomy lands in T519/T520. For CAPTURE-HAPPY
      // we surface this as an Unauthorized — the test exercise always
      // sets a store, so this branch is defensive.
      throw new UnauthorizedException("store_context_required");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.unknownItemsService.captureItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      // Use the request's correlation id when available; fall back to a
      // freshly-minted UUID — 003 requires `correlation_id NOT NULL`.
      correlationId:
        (request as { requestId?: string }).requestId ?? randomUUID(),
      identifierType: body.identifier_type,
      identifierValue: body.identifier_value,
      sourceSystem: body.source_system ?? null,
      saleContext: body.sale_context ?? null,
    });

    return toWireShape(result.unknownItem);
  }
}
