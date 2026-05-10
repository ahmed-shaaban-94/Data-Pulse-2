/**
 * invitations.repository.unit.spec.ts
 *
 * Docker-free unit coverage for InvitationsRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB chain — same pattern as
 * stores.repository.unit.spec.ts. Each public method is exercised with a
 * fresh `makeFakeDb()` closure per test (via `drizzle.mockImplementation`
 * in beforeEach) so there is no shared mutable state between cases.
 *
 * Chain shapes used by InvitationsRepository:
 *
 *   1. select(p).from(t).where(c).limit(1)  -> Promise<Row[]>  (findPendingByEmail,
 *                                                                findRoleId, findByTokenHash,
 *                                                                findUserByEmail)
 *   2. select(p).from(t).where(c)           -> Promise<Row[]>  (findInvalidStoreIds — NO limit;
 *                                                                awaited directly as thenable)
 *   3. insert(t).values(v).returning()      -> Promise<Row[]>  (create, createMembership)
 *   4. insert(t).values(v)                  -> awaitable void  (insertStoreAccessRows — NO returning)
 *   5. update(t).set(p).where(c)            -> awaitable { rowCount } (autoExpireStale, markAccepted)
 *
 * The fake's `where()` returns `whereResult`, an object that is:
 *   - Thenable (`.then`) → resolves to `_selectRows` in "select" mode or
 *     `{ rowCount: _updateRowCount }` in "update" mode (shapes 2 and 5).
 *   - Has `.limit()` → for shape 1 select queries.
 *   - Has `.returning()` → not used on update in this repo, only on insert.
 *
 * insertStoreAccessRows calls `insert(t).values(v)` and awaits the result
 * (no `.returning()`). The insertChain itself is awaitable via a custom
 * `.then` that resolves to `undefined` after `.values()` is called.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake DB resolves whatever rows are seeded in `_selectRows` /
 * `_insertRows` regardless of tenant context — RLS is a DB-layer guarantee
 * tested only with a real Postgres instance (Testcontainers integration spec).
 */

import { InvitationsRepository } from "../../src/memberships/invitations.repository";
import type { InvitationRow, MembershipRow, UserRow } from "@data-pulse-2/db/schema";
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const INVITATION_ID = "0193c000-0000-7000-8000-000000000001";
const ROLE_ID = "0193c000-0000-7000-8000-000000000002";
const USER_ID = "0193c000-0000-7000-8000-000000000003";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-000000000004";
const STORE_ID_1 = "0193c000-0000-7000-8000-000000000010";
const STORE_ID_2 = "0193c000-0000-7000-8000-000000000011";
const TOKEN_HASH = Buffer.from("fake-token-hash-32-bytes-padding!!");
const NORMALIZED_EMAIL = "user@example.com";

// ---------------------------------------------------------------------------
// Module-level state — reset in beforeEach
// ---------------------------------------------------------------------------

let _selectRows: unknown[] = [];
let _insertRows: unknown[] = [];
let _updateRowCount: number | null = 1;

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------

function makeFakeDb() {
  let _chainMode: "select" | "update" = "select";

  // insertChain supports both:
  //   shape 3: insert(t).values(v).returning() -> Promise<Row[]>
  //   shape 4: insert(t).values(v)             -> awaitable void (thenable)
  const insertChain = {
    values: (_v: unknown) => insertChain,
    returning: () => Promise.resolve(_insertRows),
    // Allow `await db.insert(t).values(v)` without .returning() (shape 4)
    then: (
      resolve: (v: undefined) => void,
      _reject?: (e: unknown) => void,
    ) => {
      return Promise.resolve(undefined).then(resolve, _reject);
    },
  };

  const whereResult = {
    // Shape 2 (findInvalidStoreIds — select without limit) or
    // Shape 5 (autoExpireStale / markAccepted — update without returning).
    then: (
      resolve: (v: unknown[] | { rowCount: number | null }) => void,
      _reject?: (e: unknown) => void,
    ) => {
      if (_chainMode === "update") {
        return Promise.resolve({ rowCount: _updateRowCount }).then(
          resolve as (v: { rowCount: number | null }) => void,
          _reject,
        );
      }
      return Promise.resolve(_selectRows).then(
        resolve as (v: unknown[]) => void,
        _reject,
      );
    },
    // Shape 1 (select with .limit(1))
    limit: (_n: number) => Promise.resolve(_selectRows),
  };

  const chain: Record<string, unknown> = {
    // insert chain (shapes 3 + 4)
    insert: () => insertChain,
    // select chain — sets mode to "select"
    select: (_fields?: unknown) => {
      _chainMode = "select";
      return chain;
    },
    from: () => chain,
    // update chain — sets mode to "update"
    update: () => {
      _chainMode = "update";
      return chain;
    },
    set: () => chain,
    // shared where (select and update)
    where: () => whereResult,
  };

  return chain;
}

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeInvitationRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITATION_ID,
    tenantId: TENANT_ID,
    email: NORMALIZED_EMAIL,
    roleId: ROLE_ID,
    storeAccessKind: "all",
    invitedStoreIds: [],
    invitedByUserId: USER_ID,
    tokenHash: TOKEN_HASH,
    status: "pending",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as InvitationRow;
}

function makeMembershipRow(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: MEMBERSHIP_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    roleId: ROLE_ID,
    storeAccessKind: "all",
    revokedAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as MembershipRow;
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    email: NORMALIZED_EMAIL,
    emailVerifiedAt: null,
    passwordHash: null,
    displayName: "Test User",
    isPlatformAdmin: false,
    clerkUserId: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as UserRow;
}

// ---------------------------------------------------------------------------
// Builder: construct InvitationsRepository and fake PoolClient
// ---------------------------------------------------------------------------

function buildRepo() {
  const repo = new InvitationsRepository();
  const fakeClient = {} as PoolClient;
  return { repo, fakeClient };
}

// ---------------------------------------------------------------------------
// Reset shared DB state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _selectRows = [];
  _insertRows = [];
  _updateRowCount = 1;

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());
});

// ===========================================================================
// A. autoExpireStale
// ===========================================================================

describe("InvitationsRepository.autoExpireStale", () => {
  it("A1: resolves without throwing (update path exercised)", async () => {
    _updateRowCount = 3;
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.autoExpireStale(fakeClient, TENANT_ID, NORMALIZED_EMAIL),
    ).resolves.toBeUndefined();
  });

  it("A2: resolves even when no rows are expired (rowCount = 0)", async () => {
    _updateRowCount = 0;
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.autoExpireStale(fakeClient, TENANT_ID, NORMALIZED_EMAIL),
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// B. findPendingByEmail
// ===========================================================================

describe("InvitationsRepository.findPendingByEmail", () => {
  it("B3: returns true when DB returns at least one row", async () => {
    _selectRows = [makeInvitationRow()];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findPendingByEmail(fakeClient, TENANT_ID, NORMALIZED_EMAIL);

    expect(result).toBe(true);
  });

  it("B4: returns false when DB returns empty array", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findPendingByEmail(fakeClient, TENANT_ID, NORMALIZED_EMAIL);

    expect(result).toBe(false);
  });
});

// ===========================================================================
// C. create
// ===========================================================================

describe("InvitationsRepository.create", () => {
  it("C5: returns InvitationRow on successful insert", async () => {
    const row = makeInvitationRow();
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.create(fakeClient, {
      id: INVITATION_ID,
      tenantId: TENANT_ID,
      email: NORMALIZED_EMAIL,
      roleId: ROLE_ID,
      storeAccessKind: "all",
      invitedStoreIds: [],
      invitedByUserId: USER_ID,
      tokenHash: TOKEN_HASH,
      expiresAt: row.expiresAt,
    });

    expect(result).toBe(row);
    expect(result.id).toBe(INVITATION_ID);
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.status).toBe("pending");
  });

  it("C6: throws with correct message when insert returns empty array", async () => {
    _insertRows = [];
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.create(fakeClient, {
        id: INVITATION_ID,
        tenantId: TENANT_ID,
        email: NORMALIZED_EMAIL,
        roleId: ROLE_ID,
        storeAccessKind: "all",
        invitedStoreIds: [],
        invitedByUserId: USER_ID,
        tokenHash: TOKEN_HASH,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    ).rejects.toThrow("create invitation: INSERT returned no row");
  });

  it("C7: specific store access kind stored correctly", async () => {
    const row = makeInvitationRow({
      storeAccessKind: "specific",
      invitedStoreIds: [STORE_ID_1],
    });
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.create(fakeClient, {
      id: INVITATION_ID,
      tenantId: TENANT_ID,
      email: NORMALIZED_EMAIL,
      roleId: ROLE_ID,
      storeAccessKind: "specific",
      invitedStoreIds: [STORE_ID_1],
      invitedByUserId: USER_ID,
      tokenHash: TOKEN_HASH,
      expiresAt: row.expiresAt,
    });

    expect(result.storeAccessKind).toBe("specific");
    expect(result.invitedStoreIds).toEqual([STORE_ID_1]);
  });
});

// ===========================================================================
// D. findRoleId
// ===========================================================================

describe("InvitationsRepository.findRoleId", () => {
  it("D8: returns role id when found", async () => {
    _selectRows = [{ id: ROLE_ID }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findRoleId(fakeClient, TENANT_ID, "store_manager");

    expect(result).toBe(ROLE_ID);
  });

  it("D9: returns null when no matching role", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findRoleId(fakeClient, TENANT_ID, "unknown_role");

    expect(result).toBeNull();
  });
});

// ===========================================================================
// E. findByTokenHash
// ===========================================================================

describe("InvitationsRepository.findByTokenHash", () => {
  it("E10: returns InvitationRow when token hash matches", async () => {
    const row = makeInvitationRow();
    _selectRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findByTokenHash(fakeClient, TOKEN_HASH);

    expect(result).toBe(row);
    expect(result!.id).toBe(INVITATION_ID);
  });

  it("E11: returns null when no row matches", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findByTokenHash(fakeClient, TOKEN_HASH);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// F. findInvalidStoreIds
// ===========================================================================

describe("InvitationsRepository.findInvalidStoreIds", () => {
  it("F12: returns empty array immediately when input ids is empty (early-return, no DB call)", async () => {
    const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
      drizzle: jest.Mock;
    };
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, []);

    expect(result).toEqual([]);
    // Early-return must NOT reach drizzle — DB is never called
    expect(drizzle).not.toHaveBeenCalled();
  });

  it("F13: returns empty array when all ids are valid (all found in DB)", async () => {
    _selectRows = [{ id: STORE_ID_1 }, { id: STORE_ID_2 }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, [
      STORE_ID_1,
      STORE_ID_2,
    ]);

    expect(result).toEqual([]);
  });

  it("F14: returns the ids missing from DB response (invalid ids filtered out)", async () => {
    // Only STORE_ID_1 is returned as valid; STORE_ID_2 is absent (invalid/deleted)
    _selectRows = [{ id: STORE_ID_1 }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, [
      STORE_ID_1,
      STORE_ID_2,
    ]);

    expect(result).toEqual([STORE_ID_2]);
  });

  it("F15: all ids invalid — returns all input ids", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, [
      STORE_ID_1,
      STORE_ID_2,
    ]);

    expect(result).toEqual([STORE_ID_1, STORE_ID_2]);
  });
});

// ===========================================================================
// G. findUserByEmail
// ===========================================================================

describe("InvitationsRepository.findUserByEmail", () => {
  it("G16: returns UserRow when user found", async () => {
    const user = makeUserRow();
    _selectRows = [user];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findUserByEmail(fakeClient, NORMALIZED_EMAIL);

    expect(result).toBe(user);
    expect(result!.email).toBe(NORMALIZED_EMAIL);
  });

  it("G17: returns null when no matching user", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findUserByEmail(fakeClient, NORMALIZED_EMAIL);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// H. markAccepted
// ===========================================================================

describe("InvitationsRepository.markAccepted", () => {
  it("H18: rowCount = 1 — returns true (won the accept race)", async () => {
    _updateRowCount = 1;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.markAccepted(fakeClient, INVITATION_ID, USER_ID);

    expect(result).toBe(true);
  });

  it("H19: rowCount = 0 — returns false (already accepted/expired/revoked)", async () => {
    _updateRowCount = 0;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.markAccepted(fakeClient, INVITATION_ID, USER_ID);

    expect(result).toBe(false);
  });

  it("H20: rowCount = null — returns false (covers the ?? 0 branch)", async () => {
    _updateRowCount = null;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.markAccepted(fakeClient, INVITATION_ID, USER_ID);

    expect(result).toBe(false);
  });
});

// ===========================================================================
// I. createMembership
// ===========================================================================

describe("InvitationsRepository.createMembership", () => {
  it("I21: returns MembershipRow on successful insert", async () => {
    const row = makeMembershipRow();
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.createMembership(fakeClient, {
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      storeAccessKind: "all",
    });

    expect(result).toBe(row);
    expect(result.id).toBe(MEMBERSHIP_ID);
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("I22: throws with correct message when insert returns empty array", async () => {
    _insertRows = [];
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.createMembership(fakeClient, {
        id: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        storeAccessKind: "all",
      }),
    ).rejects.toThrow("createMembership: INSERT returned no row");
  });

  it("I23: specific store access kind is preserved in returned row", async () => {
    const row = makeMembershipRow({ storeAccessKind: "specific" });
    _insertRows = [row];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.createMembership(fakeClient, {
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      storeAccessKind: "specific",
    });

    expect(result.storeAccessKind).toBe("specific");
  });
});

// ===========================================================================
// J. insertStoreAccessRows
// ===========================================================================

describe("InvitationsRepository.insertStoreAccessRows", () => {
  it("J24: returns immediately without DB call when storeIds is empty (early-return)", async () => {
    const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
      drizzle: jest.Mock;
    };
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.insertStoreAccessRows(fakeClient, MEMBERSHIP_ID, TENANT_ID, []),
    ).resolves.toBeUndefined();

    // Early-return must NOT reach drizzle
    expect(drizzle).not.toHaveBeenCalled();
  });

  it("J25: resolves without throwing when storeIds is non-empty (insert path exercised)", async () => {
    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.insertStoreAccessRows(fakeClient, MEMBERSHIP_ID, TENANT_ID, [
        STORE_ID_1,
        STORE_ID_2,
      ]),
    ).resolves.toBeUndefined();
  });
});
