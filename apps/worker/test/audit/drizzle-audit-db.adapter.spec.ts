/**
 * DrizzleAuditDbAdapter spec — PR-D wiring slice.
 *
 * Pure unit-level. The adapter is a thin pass-through:
 *   `insertAuditEvent(row)` → `injectedInsertFn(pool, row)`.
 *
 * No real Postgres, no Drizzle, no `runWithTenantContext` — those live
 * inside `@data-pulse-2/db.insertAuditEvent` and have their own tests
 * in `packages/db`. This spec only verifies the adapter's contract:
 *   - it forwards the pool and the row 1:1
 *   - it propagates rejections from the underlying insert function
 *   - the worker-local row shape is structurally compatible with the
 *     `@data-pulse-2/db` row shape (compile-time check; the file does
 *     not compile if either side drifts)
 *
 * The compile-time shape check is enforced inside the adapter file
 * itself (see `_ShapeIsCompatible` in `drizzle-audit-db.adapter.ts`).
 * Here we add a runtime shape assertion that a representative
 * worker-shaped row can be passed to the adapter without `as` casts —
 * which is itself only possible if the two interfaces are assignable.
 */
import type { Pool } from "pg";

import {
  DrizzleAuditDbAdapter,
  NoOpAuditDbAdapter,
  type InsertAuditEventFn,
} from "../../src/audit/drizzle-audit-db.adapter";
import type { AuditEventInsertRow } from "../../src/audit/audit-fanout.processor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_POOL = { _isFakePool: true } as unknown as Pool;

const VALID_ROW: AuditEventInsertRow = {
  id:            "018e4a1b-1234-7abc-8def-000000000001",
  actor_user_id: "0a000000-0000-7000-8000-00000000aa01",
  actor_label:   null,
  tenant_id:     "0b000000-0000-7000-8000-0000000b1001",
  store_id:      "0c000000-0000-7000-8000-0000000c5001",
  action:        "context.switch.tenant",
  target_type:   "tenant",
  target_id:     "0d000000-0000-7000-8000-0000000d0001",
  request_id:    null,
  metadata:      { reason: "user request" },
};

// ---------------------------------------------------------------------------
// DrizzleAuditDbAdapter
// ---------------------------------------------------------------------------

describe("DrizzleAuditDbAdapter — forwarding", () => {
  it("forwards pool and row to the injected insertAuditEvent function", async () => {
    const captured: Array<{ pool: Pool; row: AuditEventInsertRow }> = [];
    const fakeInsert: InsertAuditEventFn = async (pool, row) => {
      captured.push({ pool, row });
    };
    const adapter = new DrizzleAuditDbAdapter(FAKE_POOL, fakeInsert);

    await adapter.insertAuditEvent(VALID_ROW);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.pool).toBe(FAKE_POOL);
    expect(captured[0]!.row).toBe(VALID_ROW);
  });

  it("does not mutate or remap the row before forwarding", async () => {
    const captured: AuditEventInsertRow[] = [];
    const fakeInsert: InsertAuditEventFn = async (_pool, row) => {
      captured.push(row);
    };
    const adapter = new DrizzleAuditDbAdapter(FAKE_POOL, fakeInsert);

    await adapter.insertAuditEvent(VALID_ROW);

    // Reference equality — adapter is a pass-through, not a copier.
    expect(captured[0]).toBe(VALID_ROW);
    // And the field shape is preserved 1:1.
    expect(captured[0]).toEqual({
      id:            VALID_ROW.id,
      actor_user_id: VALID_ROW.actor_user_id,
      actor_label:   VALID_ROW.actor_label,
      tenant_id:     VALID_ROW.tenant_id,
      store_id:      VALID_ROW.store_id,
      action:        VALID_ROW.action,
      target_type:   VALID_ROW.target_type,
      target_id:     VALID_ROW.target_id,
      request_id:    VALID_ROW.request_id,
      metadata:      VALID_ROW.metadata,
    });
  });

  it("forwards a platform-scoped row (tenant_id null) unchanged", async () => {
    const captured: AuditEventInsertRow[] = [];
    const fakeInsert: InsertAuditEventFn = async (_pool, row) => {
      captured.push(row);
    };
    const adapter = new DrizzleAuditDbAdapter(FAKE_POOL, fakeInsert);

    const platformRow: AuditEventInsertRow = { ...VALID_ROW, tenant_id: null };
    await adapter.insertAuditEvent(platformRow);

    expect(captured[0]!.tenant_id).toBeNull();
  });
});

describe("DrizzleAuditDbAdapter — error propagation", () => {
  it("propagates rejections from the underlying insertAuditEvent unchanged", async () => {
    const dbError = new Error("pg: connection refused");
    const fakeInsert: InsertAuditEventFn = async () => {
      throw dbError;
    };
    const adapter = new DrizzleAuditDbAdapter(FAKE_POOL, fakeInsert);

    await expect(adapter.insertAuditEvent(VALID_ROW)).rejects.toBe(dbError);
  });

  it("does not swallow synchronous throws from the underlying function", async () => {
    const fakeInsert = (() => {
      throw new Error("sync boom");
    }) as unknown as InsertAuditEventFn;
    const adapter = new DrizzleAuditDbAdapter(FAKE_POOL, fakeInsert);

    await expect(adapter.insertAuditEvent(VALID_ROW)).rejects.toThrow("sync boom");
  });
});

describe("DrizzleAuditDbAdapter — default insert function", () => {
  it("uses @data-pulse-2/db.insertAuditEvent when no override is provided", () => {
    // Smoke check: constructing without the second arg succeeds. The real
    // function is wired but never invoked in this spec (calling it would
    // require a live Postgres). Coverage of the real function lives in
    // `packages/db/test/helpers/audit-insert.spec.ts`.
    const adapter = new DrizzleAuditDbAdapter(FAKE_POOL);
    expect(adapter).toBeInstanceOf(DrizzleAuditDbAdapter);
  });
});

// ---------------------------------------------------------------------------
// NoOpAuditDbAdapter
// ---------------------------------------------------------------------------

describe("NoOpAuditDbAdapter", () => {
  it("resolves insertAuditEvent without doing anything", async () => {
    const adapter = new NoOpAuditDbAdapter();
    await expect(adapter.insertAuditEvent(VALID_ROW)).resolves.toBeUndefined();
  });

  it("can be called repeatedly", async () => {
    const adapter = new NoOpAuditDbAdapter();
    await adapter.insertAuditEvent(VALID_ROW);
    await adapter.insertAuditEvent(VALID_ROW);
    await adapter.insertAuditEvent({ ...VALID_ROW, tenant_id: null });
    // No assertion — the contract is "doesn't throw, doesn't persist."
  });
});
