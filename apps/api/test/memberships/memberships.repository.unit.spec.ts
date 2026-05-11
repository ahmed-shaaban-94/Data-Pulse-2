/**
 * memberships.repository.unit.spec.ts
 *
 * Docker-free unit coverage for MembershipsRepository (T304-B-api coverage lift).
 *
 * Strategy: hand-written fake for the Drizzle DB chain — same pattern as
 * invitations.repository.unit.spec.ts, extended to handle multiple sequential
 * SELECTs within a single `update()` call via a _selectRowsQueue.
 *
 * Chain shapes used by MembershipsRepository:
 *
 *   1. select(p).from(t).where(c).limit(1)  -> Promise<Row[]>  (findActive, findRoleId,
 *                                                                detail re-read, user re-read in update)
 *   2. select(p).from(t).where(c)           -> Promise<Row[]>  (findInvalidStoreIds,
 *                                                                grant rows in update — NO limit)
 *   3. update(t).set(p).where(c)            -> awaitable { rowCount } (revoke, membership update in update)
 *   4. delete(t).where(c)                   -> awaitable void  (storeAccess delete in update)
 *   5. insert(t).values(v)                  -> awaitable void  (storeAccess insert in update — NO returning)
 *
 * The fake's `where()` returns `whereResult`, an object that is:
 *   - Thenable (.then) → resolves based on `_chainMode`:
 *       "select" → pops next result from `_selectRowsQueue` (or [] if empty)
 *       "update" → resolves to `{ rowCount: _updateRowCount }`
 *       "delete" → resolves to undefined
 *   - Has `.limit()` → for shape 1 (select with .limit(1))
 *
 * insertChain supports awaiting without `.returning()` (shape 5).
 *
 * update() calls drizzle(client) once and then issues multiple sequential
 * ops on that same instance. A queue (_selectRowsQueue) is used so each
 * consecutive SELECT pops its own pre-seeded result set.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake DB resolves whatever rows are seeded regardless of tenant context —
 * RLS is a DB-layer guarantee tested only with a real Postgres instance
 * (Testcontainers integration spec).
 */

import { MembershipsRepository } from "../../src/memberships/memberships.repository";
import type { StoreAccessKind } from "@data-pulse-2/db/schema";
import type { PoolClient } from "pg";
import type { ExistingMembership } from "../../src/memberships/memberships.repository";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-000000000001";
const ROLE_ID = "0193c000-0000-7000-8000-000000000002";
const USER_ID = "0193c000-0000-7000-8000-000000000003";
const ROLE_ID_2 = "0193c000-0000-7000-8000-000000000004";
const STORE_ID_1 = "0193c000-0000-7000-8000-000000000010";
const STORE_ID_2 = "0193c000-0000-7000-8000-000000000011";

// ---------------------------------------------------------------------------
// Module-level state — reset in beforeEach
// ---------------------------------------------------------------------------

// Queue of row arrays for sequential SELECTs (used by update() which issues
// multiple selects in one method invocation).
let _selectRowsQueue: unknown[][] = [];
// Fallback when queue is empty
let _selectRows: unknown[] = [];
let _updateRowCount: number | null = 1;

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------

function makeFakeDb() {
  let _chainMode: "select" | "update" | "delete" = "select";

  // insertChain: shape 5 — insert(t).values(v) -> awaitable void (no .returning())
  const insertChain = {
    values: (_v: unknown) => insertChain,
    // Allow `await db.insert(t).values(v)` without .returning()
    then: (
      resolve: (v: undefined) => void,
      _reject?: (e: unknown) => void,
    ) => {
      return Promise.resolve(undefined).then(resolve, _reject);
    },
  };

  const whereResult = {
    // Thenable: resolves based on current chain mode
    then: (
      resolve: (v: unknown) => void,
      _reject?: (e: unknown) => void,
    ) => {
      if (_chainMode === "update") {
        return Promise.resolve({ rowCount: _updateRowCount }).then(resolve, _reject);
      }
      if (_chainMode === "delete") {
        return Promise.resolve(undefined).then(resolve, _reject);
      }
      // "select" mode: pop from queue or fall back to _selectRows
      const rows =
        _selectRowsQueue.length > 0 ? _selectRowsQueue.shift()! : _selectRows;
      return Promise.resolve(rows).then(resolve, _reject);
    },
    // Shape 1: select with .limit(1) — pop from queue
    limit: (_n: number) => {
      const rows =
        _selectRowsQueue.length > 0 ? _selectRowsQueue.shift()! : _selectRows;
      return Promise.resolve(rows);
    },
  };

  const chain: Record<string, unknown> = {
    // select chain — sets mode to "select"
    select: (_fields?: unknown) => {
      _chainMode = "select";
      return chain;
    },
    from: () => chain,
    innerJoin: () => chain,
    // update chain — sets mode to "update"
    update: () => {
      _chainMode = "update";
      return chain;
    },
    set: () => chain,
    // delete chain — sets mode to "delete"
    delete: () => {
      _chainMode = "delete";
      return chain;
    },
    // insert chain (shape 5 — no .returning())
    insert: () => insertChain,
    // shared where (select, update, delete)
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

function makeExistingMembership(overrides: Partial<ExistingMembership> = {}): ExistingMembership {
  return {
    id: MEMBERSHIP_ID,
    tenantId: TENANT_ID,
    roleId: ROLE_ID,
    storeAccessKind: "all" as StoreAccessKind,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Builder: construct MembershipsRepository and fake PoolClient
// ---------------------------------------------------------------------------

function buildRepo() {
  const repo = new MembershipsRepository();
  const fakeClient = {} as PoolClient;
  return { repo, fakeClient };
}

// ---------------------------------------------------------------------------
// Reset shared DB state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _selectRows = [];
  _selectRowsQueue = [];
  _updateRowCount = 1;

  const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
    drizzle: jest.Mock;
  };
  drizzle.mockImplementation(() => makeFakeDb());
});

// ===========================================================================
// A. revoke
// ===========================================================================

describe("MembershipsRepository.revoke", () => {
  it("A1: rowCount = 1 — returns true (membership successfully revoked)", async () => {
    _updateRowCount = 1;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.revoke(fakeClient, MEMBERSHIP_ID, TENANT_ID);

    expect(result).toBe(true);
  });

  it("A2: rowCount = 0 — returns false (not found / already revoked / cross-tenant)", async () => {
    _updateRowCount = 0;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.revoke(fakeClient, MEMBERSHIP_ID, TENANT_ID);

    expect(result).toBe(false);
  });

  it("A3: rowCount = null — returns false (covers the ?? 0 branch)", async () => {
    _updateRowCount = null;
    const { repo, fakeClient } = buildRepo();

    const result = await repo.revoke(fakeClient, MEMBERSHIP_ID, TENANT_ID);

    expect(result).toBe(false);
  });
});

// ===========================================================================
// B. findActive
// ===========================================================================

describe("MembershipsRepository.findActive", () => {
  it("B4: returns mapped ExistingMembership when row found (storeAccessKind='all')", async () => {
    _selectRows = [
      {
        id: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        roleId: ROLE_ID,
        storeAccessKind: "all",
      },
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findActive(fakeClient, MEMBERSHIP_ID, TENANT_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(MEMBERSHIP_ID);
    expect(result!.tenantId).toBe(TENANT_ID);
    expect(result!.roleId).toBe(ROLE_ID);
    expect(result!.storeAccessKind).toBe("all");
  });

  it("B5: returns mapped ExistingMembership with storeAccessKind='specific'", async () => {
    _selectRows = [
      {
        id: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        roleId: ROLE_ID,
        storeAccessKind: "specific",
      },
    ];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findActive(fakeClient, MEMBERSHIP_ID, TENANT_ID);

    expect(result!.storeAccessKind).toBe("specific");
  });

  it("B6: returns null when no row found (cross-tenant / revoked / deleted)", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findActive(fakeClient, MEMBERSHIP_ID, TENANT_ID);

    expect(result).toBeNull();
  });
});

// ===========================================================================
// C. findRoleId
// ===========================================================================

describe("MembershipsRepository.findRoleId", () => {
  it("C7: returns role id string when role found", async () => {
    _selectRows = [{ id: ROLE_ID }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findRoleId(fakeClient, TENANT_ID, "store_manager");

    expect(result).toBe(ROLE_ID);
  });

  it("C8: returns null when no matching role found", async () => {
    _selectRows = [];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findRoleId(fakeClient, TENANT_ID, "unknown_role");

    expect(result).toBeNull();
  });
});

// ===========================================================================
// D. findInvalidStoreIds
// ===========================================================================

describe("MembershipsRepository.findInvalidStoreIds", () => {
  it("D9: returns empty array immediately when input ids is empty (early-return, no DB call)", async () => {
    const { drizzle } = jest.requireMock("drizzle-orm/node-postgres") as {
      drizzle: jest.Mock;
    };
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, []);

    expect(result).toEqual([]);
    // Early-return must NOT reach drizzle
    expect(drizzle).not.toHaveBeenCalled();
  });

  it("D10: returns empty array when all ids are valid (all found in DB)", async () => {
    _selectRows = [{ id: STORE_ID_1 }, { id: STORE_ID_2 }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, [
      STORE_ID_1,
      STORE_ID_2,
    ]);

    expect(result).toEqual([]);
  });

  it("D11: returns the ids missing from DB response (one invalid)", async () => {
    // Only STORE_ID_1 is returned as valid; STORE_ID_2 is absent (invalid/deleted)
    _selectRows = [{ id: STORE_ID_1 }];
    const { repo, fakeClient } = buildRepo();

    const result = await repo.findInvalidStoreIds(fakeClient, TENANT_ID, [
      STORE_ID_1,
      STORE_ID_2,
    ]);

    expect(result).toEqual([STORE_ID_2]);
  });

  it("D12: all ids invalid — returns all input ids", async () => {
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
// E. update — role-only change (no storeAccessKind, no storeIds)
// ===========================================================================

describe("MembershipsRepository.update — role-only change", () => {
  it("E13: returns MembershipDetail with updated roleCode (storeAccessKind='all')", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "all" });

    // update() sequential selects after the membership update:
    //   1. detail re-read (innerJoin roles) → limit(1)
    //   2. (no grant select because finalKind='all')
    //   3. user re-read → limit(1)
    _selectRowsQueue = [
      // detail re-read
      [
        {
          roleCode: "tenant_admin",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "all",
        },
      ],
      // user re-read
      [{ email: "admin@example.com", displayName: "Admin User" }],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, {
      roleId: ROLE_ID_2,
    });

    expect(result.membershipId).toBe(MEMBERSHIP_ID);
    expect(result.roleCode).toBe("tenant_admin");
    expect(result.storeAccessKind).toBe("all");
    expect(result.accessibleStoreIds).toEqual([]);
    expect(result.revokedAt).toBeNull();
    expect(result.user.id).toBe(USER_ID);
    expect(result.user.email).toBe("admin@example.com");
    expect(result.user.displayName).toBe("Admin User");
  });

  it("E14: user row missing — email falls back to '' and displayName to null", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "all" });

    _selectRowsQueue = [
      // detail re-read
      [
        {
          roleCode: "store_manager",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "all",
        },
      ],
      // user re-read — empty (defensive fallback)
      [],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, { roleId: ROLE_ID_2 });

    expect(result.user.email).toBe("");
    expect(result.user.displayName).toBeNull();
  });
});

// ===========================================================================
// F. update — storeAccessKind change to "all"
// ===========================================================================

describe("MembershipsRepository.update — storeAccessKind change to 'all'", () => {
  it("F15: returns MembershipDetail with storeAccessKind='all' and empty accessibleStoreIds", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "specific" });

    // update() sequential selects:
    //   1. membership update (update mode) - handled by _updateRowCount
    //   2. delete storeAccess (delete mode)
    //   3. detail re-read → limit(1)
    //   4. (no grant select, finalKind='all')
    //   5. user re-read → limit(1)
    _selectRowsQueue = [
      // detail re-read
      [
        {
          roleCode: "tenant_admin",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "all",
        },
      ],
      // user re-read
      [{ email: "admin@example.com", displayName: null }],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, {
      storeAccessKind: "all",
    });

    expect(result.storeAccessKind).toBe("all");
    expect(result.accessibleStoreIds).toEqual([]);
    expect(result.user.displayName).toBeNull();
  });
});

// ===========================================================================
// G. update — storeAccessKind change to "specific" with storeIds
// ===========================================================================

describe("MembershipsRepository.update — storeAccessKind change to 'specific' with storeIds", () => {
  it("G16: returns MembershipDetail with storeAccessKind='specific' and populated accessibleStoreIds", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "all" });

    // update() sequential selects:
    //   1. membership update (update mode)
    //   2. delete storeAccess (delete mode)
    //   3. insert storeAccess (insert mode — no returning)
    //   4. detail re-read → limit(1)
    //   5. grant rows select (since finalKind='specific') — no limit, thenable
    //   6. user re-read → limit(1)
    _selectRowsQueue = [
      // detail re-read
      [
        {
          roleCode: "store_manager",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "specific",
        },
      ],
      // grant rows (no limit — awaited directly as thenable)
      [{ storeId: STORE_ID_1 }, { storeId: STORE_ID_2 }],
      // user re-read
      [{ email: "manager@example.com", displayName: "Manager" }],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, {
      storeAccessKind: "specific",
      storeIds: [STORE_ID_1, STORE_ID_2],
    });

    expect(result.storeAccessKind).toBe("specific");
    expect(result.accessibleStoreIds).toEqual([STORE_ID_1, STORE_ID_2]);
    expect(result.roleCode).toBe("store_manager");
    expect(result.user.email).toBe("manager@example.com");
  });
});

// ===========================================================================
// H. update — storeAccessKind change to "specific" with empty/absent storeIds
// ===========================================================================

describe("MembershipsRepository.update — storeAccessKind='specific' with no storeIds", () => {
  it("H17: storeIds undefined — delete storeAccess but no insert; finalKind='specific' returns empty accessibleStoreIds", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "all" });

    _selectRowsQueue = [
      // detail re-read
      [
        {
          roleCode: "tenant_admin",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "specific",
        },
      ],
      // grant rows — no stores granted
      [],
      // user re-read
      [{ email: "admin@example.com", displayName: "Admin" }],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, {
      storeAccessKind: "specific",
      storeIds: undefined,
    });

    expect(result.storeAccessKind).toBe("specific");
    expect(result.accessibleStoreIds).toEqual([]);
  });

  it("H18: storeIds empty array — delete storeAccess but no insert; finalKind='specific' returns empty accessibleStoreIds", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "all" });

    _selectRowsQueue = [
      [
        {
          roleCode: "tenant_admin",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "specific",
        },
      ],
      [],
      [{ email: "admin@example.com", displayName: "Admin" }],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, {
      storeAccessKind: "specific",
      storeIds: [],
    });

    expect(result.storeAccessKind).toBe("specific");
    expect(result.accessibleStoreIds).toEqual([]);
  });
});

// ===========================================================================
// I. update — storeIds only (no storeAccessKind change)
// ===========================================================================

describe("MembershipsRepository.update — storeIds only (existing kind = 'specific')", () => {
  it("I19: replaces store_access rows; returns correct accessibleStoreIds", async () => {
    // existing.storeAccessKind = 'specific' (already set); only storeIds is passed
    const existing = makeExistingMembership({ storeAccessKind: "specific" });

    _selectRowsQueue = [
      // detail re-read
      [
        {
          roleCode: "store_manager",
          userId: USER_ID,
          revokedAt: null,
          storeAccessKind: "specific",
        },
      ],
      // grant rows
      [{ storeId: STORE_ID_1 }],
      // user re-read
      [{ email: "manager@example.com", displayName: null }],
    ];

    const { repo, fakeClient } = buildRepo();

    const result = await repo.update(fakeClient, existing, {
      storeIds: [STORE_ID_1],
    });

    expect(result.storeAccessKind).toBe("specific");
    expect(result.accessibleStoreIds).toEqual([STORE_ID_1]);
  });
});

// ===========================================================================
// J. update — "membership vanished" throw path
// ===========================================================================

describe("MembershipsRepository.update — membership vanished after update", () => {
  it("J20: throws when detail re-read returns empty (row deleted mid-transaction)", async () => {
    const existing = makeExistingMembership({ storeAccessKind: "all" });

    // detail re-read returns nothing
    _selectRowsQueue = [[]];

    const { repo, fakeClient } = buildRepo();

    await expect(
      repo.update(fakeClient, existing, { roleId: ROLE_ID_2 }),
    ).rejects.toThrow("update: membership vanished after update");
  });
});
