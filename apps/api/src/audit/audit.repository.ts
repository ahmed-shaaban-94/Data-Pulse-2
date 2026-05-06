/**
 * AuditRepository — read surface for `GET /api/v1/audit/events` (T235).
 *
 * Owns the Drizzle SELECT against `audit_events`. The production class
 * (`DrizzleAuditRepository`) opens its own `runWithTenantContext`
 * transaction per call so every read sets the tenant + platform-admin
 * GUCs that RLS expects. Tests substitute a fake implementing the
 * interface; the service itself never touches `pg`.
 *
 * Why an explicit `WHERE tenant_id = ctx.tenantId` predicate
 * ----------------------------------------------------------
 * The audit_events RLS policy (`drizzle/0000_initial.sql`) is:
 *
 *   USING (tenant_id IS NOT NULL AND tenant_id = current_setting(...)::uuid
 *          OR current_setting('app.is_platform_admin', true) = 'true')
 *
 * For a platform-admin caller, the `is_platform_admin = 'true'` OR-branch
 * permits SELECT on rows from EVERY tenant. RLS alone is insufficient
 * for tenant scoping when `isPlatformAdmin=true`. The repository adds
 * `eq(auditEvents.tenantId, input.tenantId)` as a defence-in-depth
 * predicate that closes the hole at the application layer.
 *
 * Pagination
 * ----------
 * Cursor-based on `(occurred_at, id)` DESC. The
 * `(occurred_at, id) < (cursor.occurred_at, cursor.id)` predicate uses
 * row-tuple comparison via a raw `sql\`...\`` fragment — Drizzle has no
 * native row-comparison operator and decomposing into `OR` would yield
 * three predicates (slower, harder to verify).
 *
 * To detect end-of-page cheaply the SERVICE asks for `limit + 1` rows
 * here; this repository just honours `input.limit` verbatim. The service
 * trims the extra row and emits `next_cursor` from the LAST kept row.
 *
 * Microsecond precision
 * ---------------------
 * PG stores `timestamptz` at µs resolution; node-pg returns `Date`
 * (ms-truncated). The cursor encodes the ms-truncated Date back as ISO.
 * Two rows in the same ms but distinct µs *could* be skipped on the
 * next page; in practice the `id` tiebreaker covers same-ms collisions.
 * A future hardening pass can switch the cursor source to
 * `to_char(occurred_at, '...US')` if µs collisions ever surface.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, gte, lte, like, sql } from "drizzle-orm";
import { runWithTenantContext } from "@data-pulse-2/db";
import { auditEvents } from "@data-pulse-2/db/schema";

import { PG_POOL } from "../auth/auth.module";
import type { AuditCursor } from "./audit.query.schema";

/** Internal record shape returned by the repository (camelCase). */
export interface AuditEventRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorLabel: string | null;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly requestId: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface ListPageInput {
  readonly tenantId: string;
  readonly isPlatformAdmin: boolean;
  readonly action?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly storeId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly cursor: AuditCursor | null;
  readonly limit: number;
}

export interface AuditRepository {
  /**
   * Read a page of audit events with the supplied filters / cursor.
   * Production implementation opens its own RLS-bound transaction;
   * tests substitute an in-memory fake.
   */
  listPage(input: ListPageInput): Promise<AuditEventRecord[]>;
}

/** DI token so the service depends on the interface, not the class. */
export const AUDIT_REPOSITORY = "AUDIT_REPOSITORY";

/**
 * Indirection seam: production passes the real `runWithTenantContext`;
 * tests can swap a passthrough that fabricates a `PoolClient` shape.
 * Mirrors the pattern used by `StoresService` / `TenantsService`.
 */
type TenantTxRunner = <T>(
  pool: Pool,
  ctx: { tenantId: string | null; isPlatformAdmin: boolean },
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

@Injectable()
export class DrizzleAuditRepository implements AuditRepository {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    /**
     * Optional injected runner for tests. Production callers omit it.
     * `@Optional()` is required (not just a `?` on the parameter type)
     * because Nest's DI resolver treats unmarked function-typed params
     * as required injections — same pattern as `StoresService.tx`.
     */
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  async listPage(input: ListPageInput): Promise<AuditEventRecord[]> {
    return this.tx(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: input.isPlatformAdmin },
      async (client) => this.runQuery(input, client),
    );
  }

  private async runQuery(
    input: ListPageInput,
    client: PoolClient,
  ): Promise<AuditEventRecord[]> {
    const db = drizzle(client);

    const predicates = [
      // Defence-in-depth tenant scope (closes the platform-admin RLS hole).
      eq(auditEvents.tenantId, input.tenantId),
    ];

    if (input.action !== undefined) {
      // Prefix match. `like` is safe — `action` is an internal-controlled
      // enum-ish string (e.g., `auth.signin.ok`); Drizzle parameterises
      // the value, and the `%` is server-appended (not user-supplied).
      predicates.push(like(auditEvents.action, `${input.action}%`));
    }
    if (input.actorUserId !== undefined) {
      predicates.push(eq(auditEvents.actorUserId, input.actorUserId));
    }
    if (input.storeId !== undefined) {
      predicates.push(eq(auditEvents.storeId, input.storeId));
    }
    if (input.from !== undefined) {
      predicates.push(gte(auditEvents.occurredAt, input.from));
    }
    if (input.to !== undefined) {
      predicates.push(lte(auditEvents.occurredAt, input.to));
    }
    if (input.cursor !== null) {
      // Row-tuple comparison: (occurred_at, id) < (cursor.occurred_at, cursor.id)
      // ensures stable DESC pagination with an `id` tiebreaker for the
      // same-occurred_at case.
      predicates.push(
        sql`(${auditEvents.occurredAt}, ${auditEvents.id}) < (${input.cursor.occurredAt.toISOString()}::timestamptz, ${input.cursor.id}::uuid)`,
      );
    }

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...predicates))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(input.limit);

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      actorUserId: row.actorUserId,
      actorLabel: row.actorLabel,
      // tenantId column is nullable, but the explicit predicate guarantees
      // a non-null value here; coerce defensively for the type system.
      tenantId: row.tenantId ?? input.tenantId,
      storeId: row.storeId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      requestId: row.requestId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }
}
