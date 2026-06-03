/**
 * ReadDownController — 010 US1-SNAPSHOT (T035).
 *
 * Implements `posGetCatalogSnapshot` from
 * `packages/contracts/openapi/catalog/read-down.yaml`:
 *   GET /api/pos/v1/catalog/snapshot → the Resolved Sellable Store Catalogue
 *   for the device principal's (tenant_id, store_id), cursor-paginated.
 *
 * Auth / context: mirrors `posCaptureItem` / `readSale` —
 * `@UseGuards(PosOperatorAuthGuard, TenantContextGuard)` resolve the POS device
 * principal onto `req.context`; tenant/store come from there and are NEVER read
 * from the body/query as authority (FR-002/061). A supplied `branch_id` is
 * validated against the token's store scope; a mismatch is a NON-DISCLOSING 404
 * (FR-002/003/004), never an explicit "wrong store".
 *
 * Audit: `@Auditable("catalog.snapshot.read")` is passive metadata read by the
 * global AuditEmitterInterceptor (FR-080 read-access audit).
 *
 * READ-ONLY — GET only, no write surface.
 */
import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../../audit/auditable.decorator";
import { PosOperatorAuthGuard } from "../../auth/pos-operator-auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import {
  BranchIdSchema,
  LimitSchema,
  PageTokenSchema,
} from "./dto/snapshot-query.dto";
import { ReadDownCursorError } from "./read-down.cursor";
import {
  ReadDownService,
  type CatalogSnapshotPage,
} from "./read-down.service";

@Controller()
export class ReadDownController {
  constructor(private readonly readDown: ReadDownService) {}

  @Get("api/pos/v1/catalog/snapshot")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Auditable("catalog.snapshot.read")
  async getSnapshot(
    @Req() request: TenantContextRequest,
    @Query("branch_id", new ZodValidationPipe(BranchIdSchema))
    branchId: string | undefined,
    @Query("page_token", new ZodValidationPipe(PageTokenSchema))
    pageToken: string | undefined,
    @Query("limit", new ZodValidationPipe(LimitSchema))
    limit: number | undefined,
  ): Promise<CatalogSnapshotPage> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // The read is store-scoped: a POS principal with no resolved store
      // cannot snapshot a catalogue (FR-005). Reuse the existing POS code.
      throw new UnauthorizedException("store_context_required");
    }
    // FR-002/003/004 — a supplied branch_id MUST match the device token's
    // resolved store scope. A mismatch reveals nothing (non-disclosing 404),
    // identical to an absent store.
    if (branchId !== undefined && branchId !== ctx.storeId) {
      throw new NotFoundException("not_found");
    }

    try {
      return await this.readDown.getSnapshot(ctx.tenantId, ctx.storeId, {
        limit,
        pageToken: pageToken ?? null,
      });
    } catch (err) {
      if (err instanceof ReadDownCursorError) {
        // A malformed / foreign-scope page_token is non-disclosing (FR-024).
        throw new NotFoundException("not_found");
      }
      throw err;
    }
  }
}
