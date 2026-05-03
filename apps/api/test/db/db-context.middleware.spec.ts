/**
 * T154 — db-context spec.
 *
 * Pure unit-level. Verifies the bridge from `ResolvedContext` (api
 * shape) to `TenantContext` (db shape) and the
 * `runRequestScopedTenantContext` helper that delegates to the
 * underlying `runWithTenantContext` from `@data-pulse-2/db`.
 *
 * No Postgres, no Testcontainers, no real `pg.Pool`. The
 * `runWithTenantContext` package function is verified end-to-end
 * (GUC-actually-set) by `packages/db/__tests__/middleware/tenant-context.spec.ts`
 * (T072); we don't duplicate that proof here. The api side's only
 * new responsibility is forwarding the right arguments — that is
 * what this spec pins.
 *
 * Coverage matches the approved test list:
 *   - tenantContextFromResolved maps session, token, platform-admin,
 *     and null-tenant cases correctly
 *   - runRequestScopedTenantContext throws when ALS missing
 *   - runRequestScopedTenantContext delegates to runWithTenantContext
 *     with correct args (pool, mappedCtx, work)
 *   - work errors propagate
 */
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "@data-pulse-2/db";
import {
  runRequestScopedTenantContext,
  tenantContextFromResolved,
} from "../../src/db/db-context";
import { runInContext } from "../../src/context/context.als";
import type { ResolvedContext } from "../../src/context/types";

// Re-export pin: db-context.middleware.ts must surface the same
// helpers (bridges to the spec-named file path).
import * as middleware from "../../src/db/db-context.middleware";

const TENANT_ID = "00000000-0000-7000-8000-0000000ten01";
const USER_ID = "00000000-0000-7000-8000-00000000aa01";
const STORE_ID = "00000000-0000-7000-8000-0000000sto01";

const SESSION_CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: STORE_ID,
  isPlatformAdmin: false,
  source: "session",
};

const TOKEN_CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "token",
};

const PLATFORM_ADMIN_SESSION: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: true,
  source: "session",
};

const PLATFORM_ADMIN_NULL_TENANT: ResolvedContext = {
  userId: USER_ID,
  tenantId: null,
  storeId: null,
  isPlatformAdmin: true,
  source: "token",
};

describe("db-context.middleware re-exports", () => {
  // The spec requires db-context.middleware.ts to surface the helpers
  // by their public names. This pins the re-export contract.
  it("re-exports runRequestScopedTenantContext", () => {
    expect(middleware.runRequestScopedTenantContext).toBe(
      runRequestScopedTenantContext,
    );
  });
  it("re-exports tenantContextFromResolved", () => {
    expect(middleware.tenantContextFromResolved).toBe(
      tenantContextFromResolved,
    );
  });
});

describe("tenantContextFromResolved", () => {
  it("maps a session context (non-admin) to { tenantId, isPlatformAdmin: false }", () => {
    expect(tenantContextFromResolved(SESSION_CTX)).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
  });

  it("maps a token context (non-admin) the same way", () => {
    expect(tenantContextFromResolved(TOKEN_CTX)).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
  });

  it("maps a platform-admin session with active tenant to { tenantId, isPlatformAdmin: true }", () => {
    expect(tenantContextFromResolved(PLATFORM_ADMIN_SESSION)).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: true,
    });
  });

  it("preserves null tenantId for platform-scoped callers", () => {
    expect(tenantContextFromResolved(PLATFORM_ADMIN_NULL_TENANT)).toEqual({
      tenantId: null,
      isPlatformAdmin: true,
    });
  });

  it("ignores fields that are not part of the GUC contract (userId, storeId, source)", () => {
    const result = tenantContextFromResolved(SESSION_CTX);
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("storeId");
    expect(result).not.toHaveProperty("source");
  });
});

describe("runRequestScopedTenantContext — preconditions", () => {
  it("throws synchronously when no ALS context is present", async () => {
    const fakePool = {} as Pool;
    await expect(
      runRequestScopedTenantContext(fakePool, async () => undefined),
    ).rejects.toThrow(/no ALS tenant context/);
  });

  it("error message names ContextInterceptor and TenantContextGuard for diagnostic clarity", async () => {
    const fakePool = {} as Pool;
    await expect(
      runRequestScopedTenantContext(fakePool, async () => undefined),
    ).rejects.toThrow(/ContextInterceptor/);
    await expect(
      runRequestScopedTenantContext(fakePool, async () => undefined),
    ).rejects.toThrow(/TenantContextGuard/);
  });
});

describe("runRequestScopedTenantContext — delegation", () => {
  it("delegates to runWithTenantContext with the mapped ctx and forwards the pool + work fn", async () => {
    const fakePool = { __token: "fake-pool" } as unknown as Pool;
    const fakeClient = { __token: "fake-client" } as unknown as PoolClient;

    const calls: Array<{ pool: Pool; ctx: TenantContext }> = [];
    const fakeRunner = jest
      .fn(async (
        pool: Pool,
        ctx: TenantContext,
        work: (client: PoolClient) => Promise<unknown>,
      ) => {
        calls.push({ pool, ctx });
        return work(fakeClient);
      });

    const work = jest.fn(async (client: PoolClient) => {
      expect(client).toBe(fakeClient);
      return 42;
    });

    const out = await runInContext(SESSION_CTX, () =>
      runRequestScopedTenantContext(
        fakePool,
        work,
        fakeRunner as unknown as typeof runRequestScopedTenantContext extends (
          ...args: infer A
        ) => unknown
          ? Extract<A[2], Function>
          : never,
      ),
    );

    expect(out).toBe(42);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pool).toBe(fakePool);
    expect(calls[0]!.ctx).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
  });

  it("forwards platform-admin / null-tenant ctx unchanged", async () => {
    const fakePool = {} as Pool;
    const seen: TenantContext[] = [];
    const fakeRunner = async <T>(
      _pool: Pool,
      ctx: TenantContext,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      seen.push(ctx);
      return work({} as PoolClient);
    };

    await runInContext(PLATFORM_ADMIN_NULL_TENANT, () =>
      runRequestScopedTenantContext(fakePool, async () => "ok", fakeRunner),
    );

    expect(seen).toEqual([{ tenantId: null, isPlatformAdmin: true }]);
  });

  it("propagates errors from work without swallowing", async () => {
    const fakePool = {} as Pool;
    const passthroughRunner = async <T>(
      _pool: Pool,
      _ctx: TenantContext,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => work({} as PoolClient);

    await expect(
      runInContext(SESSION_CTX, () =>
        runRequestScopedTenantContext(
          fakePool,
          async () => {
            throw new Error("query-failed");
          },
          passthroughRunner,
        ),
      ),
    ).rejects.toThrow("query-failed");
  });

  it("propagates errors from the runner (e.g., transaction setup failure)", async () => {
    const fakePool = {} as Pool;
    const erroringRunner = async (): Promise<never> => {
      throw new Error("BEGIN failed");
    };

    await expect(
      runInContext(SESSION_CTX, () =>
        runRequestScopedTenantContext(
          fakePool,
          async () => "unreached",
          erroringRunner as unknown as Parameters<
            typeof runRequestScopedTenantContext
          >[2],
        ),
      ),
    ).rejects.toThrow("BEGIN failed");
  });
});
