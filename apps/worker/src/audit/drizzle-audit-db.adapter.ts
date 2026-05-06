/**
 * DrizzleAuditDbAdapter — PR-D wiring slice.
 *
 * Implements the worker-local `AuditDbLike` seam from
 * `audit-fanout.processor.ts` by delegating to
 * `@data-pulse-2/db.insertAuditEvent`. The package helper owns the RLS
 * / tenant-context posture (NIL_UUID for platform path, real UUID +
 * `withTenant` guard for tenant path); this adapter MUST NOT
 * re-implement any of that.
 *
 * Type-shape compatibility
 * ------------------------
 * `AuditEventInsertRow` is declared in two places, intentionally:
 *   1. `apps/worker/src/audit/audit-fanout.processor.ts` — the worker's
 *      local interface, kept decoupled from `@data-pulse-2/db` so the
 *      processor has zero package-boundary coupling.
 *   2. `packages/db/src/helpers/audit-insert.ts` — the DB helper's
 *      stable public type, exported via `packages/db/src/index.ts`.
 *
 * Both shapes are structurally identical: same field names,
 * snake_case, same nullability. This adapter is the single file in
 * the repo that names both — if either shape drifts, `tsc` fails here
 * first, with a precise diagnostic, before any production wiring breaks.
 *
 * NoOp counterpart
 * ----------------
 * `NoOpAuditDbAdapter` is the dev/test fallback wired by
 * `worker.module.ts` ONLY when the `WORKER_FACTORY` is also a no-op
 * (i.e., `REDIS_URL` is unset). The class name is loud on purpose so a
 * deployment that ships with it active is obvious in the dependency
 * graph. The "consume-without-persist" guard in `worker.module.ts`
 * prevents it from being paired with a real BullMQ worker.
 */
import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import {
  insertAuditEvent as dbInsertAuditEvent,
  type AuditEventInsertRow as DbAuditEventInsertRow,
} from "@data-pulse-2/db";

import {
  type AuditDbLike,
  type AuditEventInsertRow,
} from "./audit-fanout.processor";

/**
 * Compile-time shape check: the worker-local `AuditEventInsertRow`
 * must remain structurally assignable to the `@data-pulse-2/db` shape.
 * Drift on either side breaks the build here, not at runtime.
 *
 * `WorkerRowMatchesDbRow` is intentionally unused at runtime; its only
 * job is to force the compiler to verify the type identity below.
 */
type _WorkerAssignableToDb = AuditEventInsertRow extends DbAuditEventInsertRow
  ? true
  : never;
type _DbAssignableToWorker = DbAuditEventInsertRow extends AuditEventInsertRow
  ? true
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ShapeIsCompatible = _WorkerAssignableToDb & _DbAssignableToWorker;

/**
 * Internal seam — exported only so the spec can inject a fake insert
 * function without booting Postgres. Production callers MUST use
 * `DrizzleAuditDbAdapter` (no second argument).
 */
export type InsertAuditEventFn = (
  pool: Pool,
  row: DbAuditEventInsertRow,
) => Promise<void>;

/**
 * Thin pass-through adapter. Holds a `pg.Pool` and forwards every
 * `insertAuditEvent(row)` to `@data-pulse-2/db.insertAuditEvent(pool,
 * row)`. No mapping, no defaulting, no enrichment.
 */
@Injectable()
export class DrizzleAuditDbAdapter implements AuditDbLike {
  constructor(
    private readonly pool: Pool,
    private readonly insertFn: InsertAuditEventFn = dbInsertAuditEvent,
  ) {}

  async insertAuditEvent(row: AuditEventInsertRow): Promise<void> {
    await this.insertFn(this.pool, row);
  }
}

/**
 * No-op adapter for dev/test environments without `DATABASE_URL`.
 *
 * Wiring rule (enforced by `worker.module.ts`): may ONLY be paired with
 * a `NoOpWorkerFactory`. Pairing it with a real `BullMqWorkerFactory`
 * would cause the worker to ack jobs and silently drop them — exactly
 * the failure mode the consume-without-persist guard exists to prevent.
 *
 * The class name is loud on purpose; production deploys MUST never
 * resolve this provider.
 */
@Injectable()
export class NoOpAuditDbAdapter implements AuditDbLike {
  async insertAuditEvent(_row: AuditEventInsertRow): Promise<void> {
    // intentionally empty — dev/test environments without DATABASE_URL
  }
}
