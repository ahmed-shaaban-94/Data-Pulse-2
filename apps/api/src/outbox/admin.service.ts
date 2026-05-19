/**
 * OutboxAdminService — business logic for the dead-letter triage endpoints
 * (T591, slice 1C-C1).
 *
 * Responsibilities
 * ----------------
 *   1. Translate the parsed query (post-Zod, with the cursor already
 *      decoded into `{ occurredAt, eventId }`) into the DB repository's
 *      `ListDeadLetteredInput` shape.
 *   2. Ask the repository for `limit + 1` rows so end-of-page is
 *      detectable in one round-trip; build `next_cursor` from the LAST
 *      kept row when the page was full.
 *   3. Project `OutboxDeadLetterRecord` (Date objects, snake_case) into
 *      `OutboxDeadLetterDto` (ISO strings, snake_case).
 *
 * Defence-in-depth on `last_error_class`
 * --------------------------------------
 * The repository already passes the column value through
 * `sanitizeLastErrorClass` before returning it. The service does NOT
 * re-sanitize because doing so would silently mask a regression in the
 * repo. The contract is: if the repo gave us a string, it has already
 * been validated as a bare class identifier. Tests pin this invariant.
 *
 * What this service does NOT do
 * -----------------------------
 *   - Authorize the request — the controller's `@PlatformAdminOnly()` +
 *     `RolesGuard` handle that.
 *   - Read `outbox_events` directly — every DB touch goes through the
 *     repository functions which themselves wrap `runWithTenantContext`.
 *   - Log row-level details. The service emits no log lines containing
 *     `event_id`, `tenant_id`, or other row fields (Constitution P14).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import {
  getDeadLettered,
  listDeadLettered,
  type OutboxDeadLetterRecord,
} from "@data-pulse-2/db";

import { PG_POOL } from "../auth/auth.module";
import {
  encodeCursor,
  type OutboxAdminCursor,
} from "./admin.query.schema";
import type {
  ListOutboxDeadLettersResponse,
  OutboxDeadLetterDto,
} from "./admin.dto";

/** Service-level input — post-Zod, with the cursor already decoded. */
export interface ListOutboxDeadLettersInput {
  readonly eventType?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly cursor?: OutboxAdminCursor | undefined;
  readonly limit: number;
}

@Injectable()
export class OutboxAdminService {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async list(
    input: ListOutboxDeadLettersInput,
  ): Promise<ListOutboxDeadLettersResponse> {
    // Fetch limit + 1 so we can detect end-of-page in one round-trip.
    const fetchLimit = input.limit + 1;

    const rows = await listDeadLettered(this.pool, {
      ...(input.eventType !== undefined && { eventType: input.eventType }),
      ...(input.tenantId !== undefined && { tenantId: input.tenantId }),
      ...(input.cursor !== undefined && {
        cursor: {
          // Microsecond-precision timestamptz text, carried verbatim
          // through the cursor codec -- see admin.query.schema.ts.
          occurredAtText: input.cursor.occurredAtText,
          eventId: input.cursor.eventId,
        },
      }),
      limit: fetchLimit,
    });

    const hasMore = rows.length > input.limit;
    const kept = hasMore ? rows.slice(0, input.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && kept.length > 0) {
      const last = kept[kept.length - 1]!;
      // last.occurred_at_text is the µs-precision projection -- using
      // last.occurred_at (a JS Date) would drop sub-millisecond digits
      // and cause keyset pagination to gap or duplicate rows that
      // share a millisecond bucket. See repository.ts mapRow().
      nextCursor = encodeCursor(last.occurred_at_text, last.event_id);
    }

    return {
      items: kept.map(toDto),
      next_cursor: nextCursor,
    };
  }

  /**
   * Detail endpoint. Returns `null` when the row is missing OR exists
   * but is not in `dead_lettered` state — the controller maps null to
   * 404 so both shapes are externally indistinguishable.
   */
  async get(eventId: string): Promise<OutboxDeadLetterDto | null> {
    const row = await getDeadLettered(this.pool, eventId);
    return row ? toDto(row) : null;
  }
}

/** Project a repository row to the wire shape (Date -> ISO string). */
function toDto(row: OutboxDeadLetterRecord): OutboxDeadLetterDto {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    tenant_id: row.tenant_id,
    store_id: row.store_id,
    delivery_state: "dead_lettered" as const,
    attempts: row.attempts,
    correlation_id: row.correlation_id,
    last_error_class: row.last_error_class,
    occurred_at: row.occurred_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    processed_at: row.processed_at ? row.processed_at.toISOString() : null,
  };
}
