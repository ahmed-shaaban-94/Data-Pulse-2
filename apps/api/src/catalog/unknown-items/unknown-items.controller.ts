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
 *   interceptor emits one audit-event per successful response.
 *
 *   Audit-subject branching (T514): the `AuditEmitterInterceptor` reads
 *   the metadata key from the route handler BEFORE invoking the handler
 *   (audit-emitter.interceptor.ts:75-83), so the decorator string is
 *   fixed per route at module-load time. Mutating the subject per branch
 *   would require either (a) injecting `AUDIT_JOB_ENQUEUER` into this
 *   controller and emitting programmatically — disallowed because the
 *   CAPTURE-HAPPY integration spec wires this controller without the
 *   audit module's providers, so adding a constructor dependency would
 *   regress the existing test — or (b) modifying `AuditEmitterInterceptor`
 *   itself, which is forbidden surface for 005. The safest choice is to
 *   keep ONE static subject for both outcomes: `unknown_item.captured`
 *   is semantically accurate for the POS capture *request* regardless
 *   of whether it resolved or fell through to a new pending row. A
 *   future audit-taxonomy refinement (e.g. T546) can split this if
 *   downstream needs require it. Deep audit-event assertion lives in T546.
 *
 * Validation:
 *   The Zod schema in `./dto/capture-request.dto.ts` is the boundary
 *   for FR-070 / FR-071. CAPTURE-HAPPY ships a minimal schema covering
 *   the happy-path fields; T520 (005-WAVE1-VALIDATION) tightens it.
 *
 * Status code (T514):
 *   - 200 OK for the `resolved` outcome (alias hit — no row created).
 *   - 201 Created for the `unknown` outcome (new pending row).
 *
 *   Status branching uses NestJS's `@Res({ passthrough: true })` pattern
 *   so the handler still returns a body (the global interceptors —
 *   logging, idempotency replay storage — keep working) while setting
 *   the status code programmatically. The route-level `@HttpCode`
 *   decorator is removed because it would override `res.status(...)`.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
} from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { Auditable } from "../../audit/auditable.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  PosCaptureItemRequestSchema,
  type PosCaptureItemRequestDto,
} from "./dto/capture-request.dto";
import { IdempotencyMismatchFilter } from "./filters/idempotency-mismatch.filter";
import {
  UnknownItemsService,
  type CapturedUnknownItemRow,
  type UnknownItemRow,
} from "./unknown-items.service";

/**
 * Zod schema for `tenantAdminListUnknownItems` query params. Mirrors
 * the OpenAPI contract `packages/contracts/openapi/catalog/unknown-items.yaml`:
 *   - status: enum, default 'pending'
 *   - store_id: UUID, optional (tenant-wide actors may narrow)
 *   - cursor: string, optional (Wave 1 accepts but ignores — see
 *     `listForTenant` comment)
 *   - limit: 1-200, default 50
 *
 * `.strict()` rejects unknown params so a typo doesn't silently pass.
 * Express query params arrive as strings; `z.coerce.number()` casts
 * `?limit=100` to a number before range validation.
 */
const ListUnknownItemsQuerySchema = z
  .object({
    status: z
      .enum(["pending", "resolved", "dismissed"])
      .optional()
      .default("pending"),
    store_id: z.string().uuid().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

type ListUnknownItemsQueryDto = z.infer<typeof ListUnknownItemsQuerySchema>;

/**
 * Wire shape of the contract's `UnknownItem` schema. Adapts the
 * service's `UnknownItemRow` (camelCase) to snake_case.
 */
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

interface ListUnknownItemsResponseBody {
  readonly items: ReadonlyArray<UnknownItemWireShape>;
  readonly next_cursor: string | null;
}

function rowToUnknownItemWireShape(row: UnknownItemRow): UnknownItemWireShape {
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

/**
 * Wire shape of the contract's `PosCaptureResolvedResponse`
 * (catalog/unknown-items.yaml#PosCaptureResolvedResponse) — discriminated
 * literal `kind: "resolved"`, required `product_id`, optional `alias_id`.
 */
interface PosCaptureResolvedResponseBody {
  readonly kind: "resolved";
  readonly product_id: string;
  readonly alias_id: string;
}

function toUnknownWireShape(
  row: CapturedUnknownItemRow,
): PosCaptureUnknownResponseBody {
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

function toResolvedWireShape(
  productId: string,
  aliasId: string,
): PosCaptureResolvedResponseBody {
  return {
    kind: "resolved",
    product_id: productId,
    alias_id: aliasId,
  };
}

/**
 * Controller class has no `@Controller(prefix)` argument — the URL
 * paths are placed on each method instead. Two route families live in
 * this controller and they have different prefixes:
 *
 *   - `posCaptureItem` is POS-facing → `/api/pos/v1/catalog/unknown-items`
 *     (CAPTURE-HAPPY, PR #317)
 *   - `tenantAdminListUnknownItems` is dashboard / tenant-admin facing
 *     → `/api/v1/catalog/unknown-items` (LIST, T524 — no `/pos/` prefix
 *     per the OpenAPI contract `packages/contracts/openapi/catalog/unknown-items.yaml`)
 *   - Future `tenantAdminDismissUnknownItem` lands at
 *     `/api/v1/catalog/unknown-items/{id}/dismiss` for the same reason
 *
 * The pre-LIST iteration used `@Controller("api/pos/v1/catalog/unknown-items")`
 * because capture was the only route. LIST forced the move to a
 * method-level path scheme — same served URLs, same supertest
 * assertions, just relocated decorators.
 */
@Controller()
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
  @Post("api/pos/v1/catalog/unknown-items")
  @Idempotent("required")
  @Auditable("unknown_item.captured")
  // METHOD-SCOPED filter — T533 / 005-WAVE1-IDEMP-MISMATCH. Catches
  // the `ConflictException` the IdempotencyInterceptor throws on a
  // payload mismatch (`code: "idempotency_key_conflict"`), emits the
  // catalog-domain `unknown_item.idempotency_mismatch_rejected` audit
  // subject + increments `idempotency_token_mismatch_total`, then
  // re-throws so GlobalExceptionFilter formats the canonical envelope.
  // Class-level scoping would inherit to LIST / DISMISS (forbidden
  // per slice stop rule).
  @UseFilters(IdempotencyMismatchFilter)
  async posCaptureItem(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(PosCaptureItemRequestSchema))
    body: PosCaptureItemRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PosCaptureResolvedResponseBody | PosCaptureUnknownResponseBody> {
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

    if (result.kind === "resolved") {
      // FR-022 / FR-030 / FR-031 — alias hit. 200 OK, no row created.
      res.status(HttpStatus.OK);
      return toResolvedWireShape(result.productId, result.aliasId);
    }

    // FR-001 — capture: a new pending row was inserted. 201 Created.
    res.status(HttpStatus.CREATED);
    return toUnknownWireShape(result.unknownItem);
  }

  /**
   * `tenantAdminListUnknownItems` — dashboard / tenant-admin queue read
   * (T524 / 005-WAVE1-LIST).
   *
   * GET /api/v1/catalog/unknown-items?status=&store_id=&cursor=&limit=
   *
   * RLS-driven visibility:
   *   - Tenant-wide actors (storeId=null) see all stores in their
   *     tenant; 003 0009 carve-out makes the `app.current_store=''`
   *     pass the `unknown_items_store_read` policy branch.
   *   - Store-scoped operators see only their bound store; the policy
   *     branch matches `store_id = app.current_store`.
   *   - Cross-tenant probes return an empty page (003
   *     `unknown_items_tenant_isolation` filters at the DB layer),
   *     NOT an authorization error — non-disclosing per SI-001 /
   *     FR-013.
   *
   * Pagination: Wave 1 single-pages within `limit` (default 50, max
   * 200 per the contract). `cursor` is accepted at the boundary so
   * `.strict()` doesn't reject it, but ignored internally — the
   * response always carries `next_cursor: null`. See `listForTenant`
   * comment for the forward-compat plan.
   *
   * Audit / idempotency:
   *   - No `@Auditable` decorator: list reads are not state
   *     transitions (FR-080 scopes audits to transitions).
   *   - No `@Idempotent` decorator: GETs are naturally idempotent
   *     and the interceptor expects a header on writes only.
   *
   * Auth / RolesGuard (documented intentional gap):
   *   This handler does NOT carry `@UseGuards(AuthGuard,
   *   TenantContextGuard, RolesGuard)` or `@Roles(...)` decorators.
   *   It inherits the same posture as `posCaptureItem` above —
   *   the route is consumed by integration tests via a
   *   configurable context guard, and production wiring of the
   *   real auth+roles stack lands in a future Wave 1 slice. Auth
   *   files (`apps/api/src/auth/**`) are forbidden surface for
   *   005 per the slice contract, so adding decorators here
   *   would silently expand scope. Flagged by CodeRabbit on
   *   PR #334; tracked as a follow-up auth-wiring slice that
   *   addresses both `posCaptureItem` and
   *   `tenantAdminListUnknownItems` consistently.
   */
  @Get("api/v1/catalog/unknown-items")
  async tenantAdminListUnknownItems(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListUnknownItemsQuerySchema))
    query: ListUnknownItemsQueryDto,
  ): Promise<ListUnknownItemsResponseBody> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    // No `store_context_required` check here — list supports both
    // tenant-wide actors (ctx.storeId === null) and store-scoped
    // actors (ctx.storeId === UUID). The service's
    // `app.current_store` GUC drives the RLS branch accordingly.

    const result = await this.unknownItemsService.listForTenant({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      status: query.status,
      limit: query.limit,
      storeIdFilter: query.store_id ?? null,
    });

    return {
      items: result.items.map(rowToUnknownItemWireShape),
      next_cursor: result.nextCursor,
    };
  }

  /**
   * `tenantAdminDismissUnknownItem` — dashboard / tenant-admin
   * dismiss action (T541 / 005-WAVE1-DISMISS).
   *
   * POST /api/v1/catalog/unknown-items/:id/dismiss
   *
   * Transitions the addressed `unknown_items` row from `pending` to
   * `dismissed` per FR-003 / FR-004. The service-layer
   * `dismissUnknownItem` enforces the monotonicity guard at the
   * UPDATE's WHERE clause + distinguishes 404 (non-disclosing)
   * from 409 (`already_reconciled`) via a conditional SELECT on
   * rowCount=0.
   *
   * Path-param validation:
   *   The `:id` segment is Zod-validated as a UUID at the controller
   *   boundary. A malformed id rejects as 400 (validation_error)
   *   before reaching the service. Matches the contract's
   *   `format: uuid` requirement.
   *
   * Audit / idempotency:
   *   - `@Auditable("unknown_item.dismissed")` fires on success only
   *     (the AuditEmitterInterceptor only emits after handler
   *     completion). The 404/409 paths throw before the interceptor
   *     can fire; rejected-dismiss audit emission is deferred to a
   *     future enhancement (tasks.md T543's `rejected=true`
   *     discriminator would need a filter pattern similar to
   *     PR #339's IDEMP-MISMATCH).
   *   - No `@Idempotent('required')` decorator: dismiss is naturally
   *     idempotent at the DB layer via the monotonicity guard.
   *     Re-dismissing returns deterministic 409 from the lifecycle
   *     invariant — no client-side dedup key needed.
   *
   * Auth gap (carried forward from CAPTURE-HAPPY / NON-DISCLOSING /
   * LIST / IDEMP-WIRE / IDEMP-MISMATCH): no `@UseGuards(AuthGuard,
   * TenantContextGuard, RolesGuard)`. Same documented intentional gap;
   * `apps/api/src/auth/**` remains forbidden surface for 005.
   * Tracked in wave-status.md "Outstanding known gap" section.
   */
  @Post("api/v1/catalog/unknown-items/:id/dismiss")
  // NestJS's `@Post()` defaults to 201 Created. The OpenAPI contract
  // for `tenantAdminDismissUnknownItem` specifies 200 OK for the
  // successful dismiss outcome (lines 299-308 of unknown-items.yaml).
  // Unlike `posCaptureItem` which branches on outcome (200 for
  // resolved alias, 201 for new pending row) and uses `@Res(...)`
  // for runtime status branching, dismiss has exactly one success
  // code — static `@HttpCode(HttpStatus.OK)` is the right shape.
  // CodeRabbit Critical catch on PR #341.
  @HttpCode(HttpStatus.OK)
  @Auditable("unknown_item.dismissed")
  async tenantAdminDismissUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid()))
    id: string,
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

    const row = await this.unknownItemsService.dismissUnknownItem({
      id,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
    });

    return rowToUnknownItemWireShape(row);
  }
}
