/**
 * ErpnextPostingController — 015-US1-FEED (T031).
 *
 * Implements `connectorPullPostings` from
 * `packages/contracts/openapi/erpnext-connector/posting-feed.yaml`:
 *   GET /api/connector/v1/erpnext/postings → a cursor-ordered page of pending
 *   posting work-items for the connector principal's tenant.
 *
 * Auth / context: `@UseGuards(ConnectorAuthGuard)` authenticates the opaque,
 * revocable MACHINE connector bearer (012 `connectorBearer`) and requires the
 * `connector` token scope. The tenant comes from the token principal ONLY
 * (`principal.tenantId`), never from the query/body (§XII). A connector token
 * with no tenant binding is a non-disclosing 401.
 *
 * READ-ONLY for the pull: NO status mutation at pull time (eligibility resolved
 * at row creation in the worker consumer) — re-pulling the same `since` cursor
 * yields the same logical set (012 idempotent replay). The outcome ACK
 * (`connectorAckOutcome`) lands in 015-US2-ACK.
 *
 * Audit: `@Auditable("erpnext.postings.pulled")` is passive metadata read by the
 * global AuditEmitterInterceptor.
 */
import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../../audit/auditable.decorator";
import type { AuthedRequest } from "../../auth/auth.guard";
import { ConnectorAuthGuard } from "../../auth/connector-auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  PullPostingsQuerySchema,
  type PullPostingsQuery,
} from "./dto/pull-postings-query.dto";
import { ErpnextPostingService } from "./erpnext-posting.service";
import type { PostingWorkItem } from "./posting-work-item.projection";

/** The 012 PostingFeedPage wire envelope (snake_case per the contract). */
interface PostingFeedPageResponse {
  readonly items: readonly PostingWorkItem[];
  readonly cursor: string;
  readonly next_page_token: string | null;
}

@Controller("api/connector/v1/erpnext")
@UseGuards(ConnectorAuthGuard)
export class ErpnextPostingController {
  constructor(private readonly service: ErpnextPostingService) {}

  @Get("postings")
  @Auditable("erpnext.postings.pulled")
  async pullPostings(
    @Req() req: AuthedRequest,
    @Query(new ZodValidationPipe(PullPostingsQuerySchema))
    query: PullPostingsQuery,
  ): Promise<PostingFeedPageResponse> {
    const principal = req.principal;
    // ConnectorAuthGuard guarantees a connector token principal; a token with no
    // tenant binding cannot scope the feed → non-disclosing 401.
    if (!principal || principal.kind !== "token" || principal.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.service.pullPostings({
      tenantId: principal.tenantId,
      since: query.since != null ? BigInt(query.since) : null,
      limit: query.limit ?? 100,
    });

    // The 012 `cursor` is required + minLength 1. On an empty page (no pending
    // rows), echo the caller's `since` so the connector can re-poll from the
    // same point; if there was no `since` either, emit "0" (the from-start
    // sentinel — every real sequence is >= 1).
    const cursor = result.cursor ?? query.since ?? "0";

    return {
      items: result.items,
      cursor,
      next_page_token: result.nextPageToken,
    };
  }
}
