/**
 * audit-insert.unit.spec.ts
 *
 * Docker-free unit tests for `_makeInsertAuditEvent` using injected fakes.
 * Matches the `.unit.spec.ts` naming convention so this file is included
 * in `--testPathPattern=unit` coverage runs (unlike the mixed-tier
 * `audit-insert.spec.ts` which is excluded by that pattern).
 *
 * NOT covered here (deferred to audit-insert.spec.ts Tier 2):
 *   - Real RLS enforcement — requires Testcontainers + real Postgres.
 *   - The drizzle insert code paths (lines 128-134) — only reachable without
 *     rawInsertFn; those require a real db connection.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit tests.
 */
import {
  _makeInsertAuditEvent,
  type AuditEventInsertRow,
  type RunCtxFn,
} from "../../src/helpers/audit-insert";
import type { NewAuditEventRow } from "../../src/schema";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const TENANT_ID = "aabbccdd-0000-7000-8000-000000000001";
const EVENT_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

const TENANT_ROW: AuditEventInsertRow = {
  id: EVENT_ID,
  tenant_id: TENANT_ID,
  action: "context.switch.tenant",
  actor_user_id: null,
  actor_label: null,
  store_id: null,
  target_type: null,
  target_id: null,
  request_id: null,
  metadata: {},
};

const PLATFORM_ROW: AuditEventInsertRow = {
  id: EVENT_ID,
  tenant_id: null,
  action: "platform.system.bootstrap",
  actor_user_id: null,
  actor_label: null,
  store_id: null,
  target_type: null,
  target_id: null,
  request_id: null,
  metadata: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeRunCtx(capturedCtx: {
  tenantId?: string | null;
  isPlatformAdmin?: boolean;
}): RunCtxFn {
  // MUST invoke work() — rawInsertFn runs inside runCtx's work callback.
  return async <T>(
    _pool: unknown,
    ctx: { tenantId: string | null; isPlatformAdmin: boolean },
    work: (client: never) => Promise<T>,
  ): Promise<T> => {
    capturedCtx.tenantId = ctx.tenantId;
    capturedCtx.isPlatformAdmin = ctx.isPlatformAdmin;
    return work(null as never);
  };
}

// ---------------------------------------------------------------------------
// Tenant path
// ---------------------------------------------------------------------------

describe("_makeInsertAuditEvent — tenant path (unit)", () => {
  it("AI-U1: calls runCtx with row.tenant_id and isPlatformAdmin=false", async () => {
    const capturedCtx: { tenantId?: string | null; isPlatformAdmin?: boolean } = {};
    const capturedRow: { row?: NewAuditEventRow; isPlatformAdmin?: boolean } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx(capturedCtx),
      async (_pool, row, isPlatformAdmin) => {
        capturedRow.row = row;
        capturedRow.isPlatformAdmin = isPlatformAdmin;
      },
    );

    await fn({} as never, TENANT_ROW);

    expect(capturedCtx.tenantId).toBe(TENANT_ID);
    expect(capturedCtx.isPlatformAdmin).toBe(false);
    expect(capturedRow.isPlatformAdmin).toBe(false);
    expect(capturedRow.row?.tenantId).toBe(TENANT_ID);
    expect(capturedRow.row?.action).toBe("context.switch.tenant");
  });

  it("AI-U2: row id is forwarded unchanged", async () => {
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => { capturedRow.row = row; },
    );

    await fn({} as never, TENANT_ROW);

    expect(capturedRow.row?.id).toBe(EVENT_ID);
  });
});

// ---------------------------------------------------------------------------
// Platform path
// ---------------------------------------------------------------------------

describe("_makeInsertAuditEvent — platform path (unit)", () => {
  it("AI-U3: explicit tenant_id: null calls runCtx with NIL_UUID and isPlatformAdmin=true", async () => {
    const capturedCtx: { tenantId?: string | null; isPlatformAdmin?: boolean } = {};
    const capturedRow: { row?: NewAuditEventRow; isPlatformAdmin?: boolean } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx(capturedCtx),
      async (_pool, row, isPlatformAdmin) => {
        capturedRow.row = row;
        capturedRow.isPlatformAdmin = isPlatformAdmin;
      },
    );

    await fn({} as never, PLATFORM_ROW);

    expect(capturedCtx.tenantId).toBe(NIL_UUID);
    expect(capturedCtx.isPlatformAdmin).toBe(true);
    expect(capturedRow.isPlatformAdmin).toBe(true);
  });

  it("AI-U4: platform row stores tenantId: undefined in NewAuditEventRow (maps to DB NULL), not NIL_UUID", async () => {
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => { capturedRow.row = row; },
    );

    await fn({} as never, PLATFORM_ROW);

    // The row stored in DB must have tenantId: undefined (DB NULL), NOT NIL_UUID.
    // NIL_UUID is only used for the GUC context — it must not leak into the row.
    expect(capturedRow.row?.tenantId).toBeUndefined();
    expect(capturedRow.row?.action).toBe("platform.system.bootstrap");
  });
});

// ---------------------------------------------------------------------------
// undefined tenant_id guard
// ---------------------------------------------------------------------------

describe("_makeInsertAuditEvent — undefined tenant_id guard (unit)", () => {
  it("AI-U5: throws when tenant_id is undefined — prevents silent platform-scoped insert", async () => {
    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async () => {},
    );

    const badRow = { ...TENANT_ROW, tenant_id: undefined } as unknown as AuditEventInsertRow;

    await expect(fn({} as never, badRow)).rejects.toThrow(
      "insertAuditEvent: tenant_id must be a UUID string or explicit null",
    );
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("_makeInsertAuditEvent — error propagation (unit)", () => {
  it("AI-U6: propagates errors thrown by runCtx", async () => {
    const boom = new Error("runCtx exploded");

    const fn = _makeInsertAuditEvent(
      async () => { throw boom; },
      async () => {},
    );

    await expect(fn({} as never, TENANT_ROW)).rejects.toThrow("runCtx exploded");
  });

  it("AI-U7: propagates errors thrown by rawInsertFn", async () => {
    const boom = new Error("insert exploded");

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async () => { throw boom; },
    );

    await expect(fn({} as never, TENANT_ROW)).rejects.toThrow("insert exploded");
  });
});

// ---------------------------------------------------------------------------
// Row field mapping
// ---------------------------------------------------------------------------

describe("_makeInsertAuditEvent — row field mapping (unit)", () => {
  it("AI-U8: null optional fields map to undefined in NewAuditEventRow", async () => {
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => { capturedRow.row = row; },
    );

    await fn({} as never, TENANT_ROW);

    expect(capturedRow.row?.actorUserId).toBeUndefined();
    expect(capturedRow.row?.actorLabel).toBeUndefined();
    expect(capturedRow.row?.storeId).toBeUndefined();
    expect(capturedRow.row?.targetType).toBeUndefined();
    expect(capturedRow.row?.targetId).toBeUndefined();
    expect(capturedRow.row?.requestId).toBeUndefined();
  });

  it("AI-U9: non-null optional fields are forwarded correctly", async () => {
    const ACTOR_ID = "aaaaaaaa-0000-7000-8000-000000000001";
    const STORE_ID = "bbbbbbbb-0000-7000-8000-000000000001";
    const REQUEST_ID = "cccccccc-0000-7000-8000-000000000001";
    const TARGET_ID = "dddddddd-0000-7000-8000-000000000001";
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => { capturedRow.row = row; },
    );

    await fn({} as never, {
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      action: "context.switch.tenant",
      actor_user_id: ACTOR_ID,
      actor_label: "alice@example.com",
      store_id: STORE_ID,
      target_type: "tenant",
      target_id: TARGET_ID,
      request_id: REQUEST_ID,
      metadata: {},
    });

    expect(capturedRow.row?.actorUserId).toBe(ACTOR_ID);
    expect(capturedRow.row?.actorLabel).toBe("alice@example.com");
    expect(capturedRow.row?.storeId).toBe(STORE_ID);
    expect(capturedRow.row?.targetType).toBe("tenant");
    expect(capturedRow.row?.targetId).toBe(TARGET_ID);
    expect(capturedRow.row?.requestId).toBe(REQUEST_ID);
  });

  it("AI-U10: metadata object is forwarded as-is", async () => {
    const capturedRow: { row?: NewAuditEventRow } = {};

    const fn = _makeInsertAuditEvent(
      makeFakeRunCtx({}),
      async (_pool, row) => { capturedRow.row = row; },
    );

    await fn({} as never, {
      ...TENANT_ROW,
      metadata: { from: "store-a", to: "store-b", reason: "manual" },
    });

    expect(capturedRow.row?.metadata).toEqual({ from: "store-a", to: "store-b", reason: "manual" });
  });
});
