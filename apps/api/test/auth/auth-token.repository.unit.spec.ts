/**
 * auth-token.repository.unit.spec.ts
 *
 * Docker-free unit coverage for AuthTokenRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB chain (same pattern as
 * session.repository.unit.spec.ts) plus a mock for @data-pulse-2/auth so
 * real SHA-256 crypto never runs in unit tests.
 *
 * The Testcontainers integration spec (auth-token.repository.spec.ts) covers:
 *   - Real clock / now() filter semantics for expires_at
 *   - RLS cross-tenant isolation via runWithTenantContext
 *   - Idempotent revoke timestamp preservation
 *   - FK constraints
 * None of those are duplicated here.
 */

import { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import type { AuthTokenRow } from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TOKEN_ID = "0193b000-0000-7000-8000-000000000020";
const USER_ID = "0193b000-0000-7000-8000-000000000001";
const TENANT_ID = "0193b000-0000-7000-8000-0000000000a1";
const RAW_TOKEN = "raw-token-value";
const HASHED_TOKEN = Buffer.from("hashed-token");

// ---------------------------------------------------------------------------
// Mock @data-pulse-2/auth — hashToken must be synchronous and return a Buffer
// ---------------------------------------------------------------------------

jest.mock("@data-pulse-2/auth", () => ({
  hashToken: jest.fn((_t: string) => Buffer.from("hashed-token")),
}));

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------
//
// AuthTokenRepository uses three chain shapes:
//
//   1. insert(t).values(v).returning()        -> Promise<AuthTokenRow[]>
//   2. select().from(t).where(c).limit(1)     -> Promise<AuthTokenRow[]>
//   3. update(t).set(p).where(c)              -> awaitable { rowCount }
//
// Shape 3 is handled by making whereResult a thenable that resolves to
// { rowCount }, matching Drizzle's raw update return type.

let _insertRows: AuthTokenRow[] = [];
let _selectRows: AuthTokenRow[] = [];
let _updateRowCount: number | null = 1;

function makeFakeDb() {
  const insertChain = {
    values: (_v: unknown) => insertChain,
    returning: () => Promise.resolve(_insertRows),
  };

  const whereResult = {
    // Shape 3: plain update — awaitable directly via thenable
    then: (
      resolve: (v: { rowCount: number | null }) => void,
      _reject?: (e: unknown) => void,
    ) => {
      return Promise.resolve({ rowCount: _updateRowCount }).then(
        resolve,
        _reject,
      );
    },
    // Shape 2 (select): limit after where
    limit: () => Promise.resolve(_selectRows),
  };

  const chain: Record<string, unknown> = {
    // insert chain
    insert: () => insertChain,
    // select chain
    select: () => chain,
    from: () => chain,
    // shared where (used by both select and update)
    where: () => whereResult,
    // update chain
    update: () => chain,
    set: () => chain,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

function makeLiveToken(overrides: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: TOKEN_ID,
    userId: USER_ID,
    tenantId: TENANT_ID,
    deviceId: null,
    storeId: null,
    tokenHash: HASHED_TOKEN,
    scope: "dashboard_api",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    issuedAt: new Date(),
    revokedAt: null,
    ...overrides,
  } as AuthTokenRow;
}

// ---------------------------------------------------------------------------
// Builder: construct AuthTokenRepository under test
// ---------------------------------------------------------------------------

function buildRepo() {
  const fakePool = {} as never;
  return new AuthTokenRepository(fakePool);
}

// ---------------------------------------------------------------------------
// Reset shared DB state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _insertRows = [];
  _selectRows = [];
  _updateRowCount = 1;

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());

  // Reset hashToken call history so spy assertions are per-test
  const { hashToken } = jest.requireMock("@data-pulse-2/auth") as {
    hashToken: jest.Mock;
  };
  hashToken.mockClear();
});

// ===========================================================================
// A. issue
// ===========================================================================

describe("AuthTokenRepository.issue", () => {
  it("hashes rawToken before inserting", async () => {
    const row = makeLiveToken();
    _insertRows = [row];
    const repo = buildRepo();

    await repo.issue(RAW_TOKEN, {
      id: TOKEN_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
      scope: "dashboard_api",
      expiresAt: row.expiresAt,
    });

    const { hashToken } = jest.requireMock("@data-pulse-2/auth") as {
      hashToken: jest.Mock;
    };
    expect(hashToken).toHaveBeenCalledTimes(1);
    expect(hashToken).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it("returns the inserted row on success", async () => {
    const row = makeLiveToken();
    _insertRows = [row];
    const repo = buildRepo();

    const result = await repo.issue(RAW_TOKEN, {
      id: TOKEN_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
      scope: "dashboard_api",
      expiresAt: row.expiresAt,
    });

    expect(result).toBe(row);
  });

  it("throws when insert returns no row", async () => {
    _insertRows = [];
    const repo = buildRepo();

    await expect(
      repo.issue(RAW_TOKEN, {
        id: TOKEN_ID,
        userId: USER_ID,
        tenantId: TENANT_ID,
        scope: "dashboard_api",
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    ).rejects.toThrow("AuthTokenRepository.issue: insert returned no row");
  });

  it("accepts a PoolClient override (client branch — does not throw)", async () => {
    const row = makeLiveToken();
    _insertRows = [row];
    const repo = buildRepo();
    const fakeClient = {} as never;

    const result = await repo.issue(
      RAW_TOKEN,
      {
        id: TOKEN_ID,
        userId: USER_ID,
        tenantId: TENANT_ID,
        scope: "dashboard_api",
        expiresAt: row.expiresAt,
      },
      fakeClient,
    );

    expect(result).toBe(row);
  });
});

// ===========================================================================
// B. findActiveByRawToken
// ===========================================================================

describe("AuthTokenRepository.findActiveByRawToken", () => {
  it("hashes rawToken before querying", async () => {
    const row = makeLiveToken();
    _selectRows = [row];
    const repo = buildRepo();

    await repo.findActiveByRawToken(RAW_TOKEN);

    const { hashToken } = jest.requireMock("@data-pulse-2/auth") as {
      hashToken: jest.Mock;
    };
    expect(hashToken).toHaveBeenCalledTimes(1);
    expect(hashToken).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it("returns the row when DB finds a match", async () => {
    const row = makeLiveToken();
    _selectRows = [row];
    const repo = buildRepo();

    const result = await repo.findActiveByRawToken(RAW_TOKEN);

    expect(result).toBe(row);
  });

  it("returns null when DB returns empty array", async () => {
    _selectRows = [];
    const repo = buildRepo();

    const result = await repo.findActiveByRawToken(RAW_TOKEN);

    expect(result).toBeNull();
  });

  it("accepts a PoolClient override (client branch — does not throw)", async () => {
    const row = makeLiveToken();
    _selectRows = [row];
    const repo = buildRepo();
    const fakeClient = {} as never;

    const result = await repo.findActiveByRawToken(RAW_TOKEN, fakeClient);

    expect(result).toBe(row);
  });
});

// ===========================================================================
// C. revoke
// ===========================================================================

describe("AuthTokenRepository.revoke", () => {
  it("returns true when rowCount > 0", async () => {
    _updateRowCount = 1;
    const repo = buildRepo();

    const result = await repo.revoke(TOKEN_ID);

    expect(result).toBe(true);
  });

  it("returns false when rowCount = 0 (already revoked)", async () => {
    _updateRowCount = 0;
    const repo = buildRepo();

    const result = await repo.revoke(TOKEN_ID);

    expect(result).toBe(false);
  });

  it("returns false when rowCount = null", async () => {
    _updateRowCount = null;
    const repo = buildRepo();

    const result = await repo.revoke(TOKEN_ID);

    expect(result).toBe(false);
  });

  it("accepts a PoolClient override (client branch — does not throw)", async () => {
    _updateRowCount = 1;
    const repo = buildRepo();
    const fakeClient = {} as never;

    const result = await repo.revoke(TOKEN_ID, fakeClient);

    expect(result).toBe(true);
  });
});
