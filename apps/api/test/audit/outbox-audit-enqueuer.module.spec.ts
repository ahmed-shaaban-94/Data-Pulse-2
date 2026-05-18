/**
 * T583 -- OutboxAuditEnqueuerModule DI-graph integration test.
 *
 * Boots the actual `AuditModule` through `Test.createTestingModule` (with
 * `PG_POOL` and the other AuthModule boot-time providers overridden so no
 * Postgres or Redis is required) and asserts what AUDIT_JOB_ENQUEUER
 * resolves to under each flag posture.
 *
 * Why this spec exists -- defence against silent re-ordering regressions
 * ---------------------------------------------------------------------
 * The live DI swap relies on Nest's "last-import-wins" semantics for
 * providers bound to the same token: AuditModule imports
 * AuditEnqueuerModule first, then OutboxAuditEnqueuerModule, so the
 * request-graph AUDIT_JOB_ENQUEUER resolves to the latter's pool-aware
 * factory. If a future refactor accidentally re-orders the imports (or
 * removes OutboxAuditEnqueuerModule entirely), the request-graph would
 * silently revert to the legacy BullMQ-direct enqueuer with OUTBOX_AUDIT_ENABLED
 * still set. This spec fails LOUDLY in that case.
 *
 * Scope of asserted behaviour
 * ---------------------------
 * - Flag OFF: AUDIT_JOB_ENQUEUER resolves to the legacy enqueuer
 *   (AuditQueueProducer when REDIS_URL is set, NoOpAuditJobEnqueuer otherwise).
 * - Flag ON + PG_POOL injected: AUDIT_JOB_ENQUEUER resolves to OutboxAuditEnqueuer.
 *
 * AuthModule's own resolution of AUDIT_JOB_ENQUEUER (used for the
 * auth.signin emission path) is NOT tested here -- AuthModule does not
 * import OutboxAuditEnqueuerModule, so its resolution stays on the legacy
 * leaf module. The deliberate-and-narrow consequence is documented in
 * outbox-audit-enqueuer.module.ts.
 *
 * No Docker, no Postgres, no Redis -- the providers required by AuthModule's
 * boot graph are overridden with stub values.
 */
import { Test } from "@nestjs/testing";

import { AuditModule } from "../../src/audit/audit.module";
import { PG_POOL } from "../../src/auth/auth.module";
import { AUDIT_JOB_ENQUEUER } from "../../src/audit/audit-job.enqueuer";
import { OutboxAuditEnqueuer } from "../../src/audit/outbox-audit-enqueuer";
import { NoOpAuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import { AuditQueueProducer } from "../../src/audit/audit-queue.producer";

// ---------------------------------------------------------------------------
// AuthModule boot-time providers that need DATABASE_URL / REDIS_URL.
// Same override-list pattern as audit.module.spec.ts so the test boots
// without external dependencies.
// ---------------------------------------------------------------------------

// PG_POOL stub: the factory only checks `pool === null`. Any non-null
// value works; the Pool constructor is lazy so no connection is opened.
// We use an explicit minimal stub rather than `new Pool(...)` so the
// test surface stays obvious.
const FAKE_PG_POOL = { __fake_pool__: true } as unknown as import("pg").Pool;

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// ---------------------------------------------------------------------------
// Helper: compile AuditModule with PG_POOL overridden to the fake (or null).
// ---------------------------------------------------------------------------
async function compileAuditModule(
  poolOverride: import("pg").Pool | null,
): Promise<{
  resolved: unknown;
  close: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AuditModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(poolOverride)
    .compile();

  // Nest's last-import-wins means OutboxAuditEnqueuerModule's provider
  // is the one returned for AUDIT_JOB_ENQUEUER. We resolve via the root
  // injector so the assertion runs against the same graph the
  // APP_INTERCEPTOR consumes.
  const resolved = moduleRef.get(AUDIT_JOB_ENQUEUER, { strict: false });

  return {
    resolved,
    close: () => moduleRef.close(),
  };
}

// ---------------------------------------------------------------------------
// Flag OFF
// ---------------------------------------------------------------------------

describe("AuditModule DI graph -- OUTBOX_AUDIT_ENABLED off (legacy path)", () => {
  it("resolves AUDIT_JOB_ENQUEUER to the legacy enqueuer when the flag is unset (NoOp without REDIS_URL)", async () => {
    delete process.env["OUTBOX_AUDIT_ENABLED"];
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "test";

    const { resolved, close } = await compileAuditModule(FAKE_PG_POOL);
    try {
      expect(resolved).toBeInstanceOf(NoOpAuditJobEnqueuer);
      expect(resolved).not.toBeInstanceOf(OutboxAuditEnqueuer);
    } finally {
      await close();
    }
  });

  it("resolves AUDIT_JOB_ENQUEUER to AuditQueueProducer when flag is unset + REDIS_URL is set", async () => {
    delete process.env["OUTBOX_AUDIT_ENABLED"];
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://localhost:6379";

    const { resolved, close } = await compileAuditModule(FAKE_PG_POOL);
    try {
      expect(resolved).toBeInstanceOf(AuditQueueProducer);
      expect(resolved).not.toBeInstanceOf(OutboxAuditEnqueuer);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Flag ON
// ---------------------------------------------------------------------------

describe("AuditModule DI graph -- OUTBOX_AUDIT_ENABLED on (T583 live swap)", () => {
  it("resolves AUDIT_JOB_ENQUEUER to OutboxAuditEnqueuer when flag is on AND PG_POOL is present", async () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";

    const { resolved, close } = await compileAuditModule(FAKE_PG_POOL);
    try {
      // Last-import-wins: OutboxAuditEnqueuerModule was imported AFTER
      // AuditEnqueuerModule in audit.module.ts, so its provider wins.
      expect(resolved).toBeInstanceOf(OutboxAuditEnqueuer);
    } finally {
      await close();
    }
  });

  it("resolves AUDIT_JOB_ENQUEUER to OutboxAuditEnqueuer for any accepted flag literal", async () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "yes";

    const { resolved, close } = await compileAuditModule(FAKE_PG_POOL);
    try {
      expect(resolved).toBeInstanceOf(OutboxAuditEnqueuer);
    } finally {
      await close();
    }
  });

  it("falls back to legacy enqueuer when flag is on but PG_POOL is null (no silent drop)", async () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://localhost:6379";

    // Suppress the expected warn line on stderr.
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const { resolved, close } = await compileAuditModule(null);
      try {
        // Legacy AuditQueueProducer takes over.
        expect(resolved).toBeInstanceOf(AuditQueueProducer);
        expect(resolved).not.toBeInstanceOf(OutboxAuditEnqueuer);
      } finally {
        await close();
      }
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
