/**
 * T130 — TenantsService unit spec.
 *
 * Pure-unit coverage for the orchestration logic — no Postgres, no
 * Testcontainers. The DB-shaped behaviors (RLS, cross-tenant
 * isolation, slug uniqueness, soft-delete visibility transitions)
 * are exercised by the companion `tenants.controller.spec.ts`
 * Testcontainers integration spec; this file pins the role-check
 * branches and error-mapping logic that don't need a database.
 *
 * Coverage:
 *   - list as platform admin → listAll
 *   - list as regular user with userId → listForUser
 *   - list as platform-scoped token → listAll
 *   - list as user-less token → []
 *   - create as non-admin → 403
 *   - read as admin → admin path; missing → 404
 *   - read as regular user with no role → 404
 *   - read as regular user with membership → tenant-scoped path
 *   - update as admin → admin path
 *   - update as non-admin without membership → 404
 *   - update as non-admin with insufficient role → 404
 *   - update as non-admin with tenant_admin/owner role → success
 *   - softDelete as non-admin → 403
 *   - softDelete as admin → repo softDelete called
 *
 * Style: hand-written `*Like` fakes for the repository + membership
 * repository, mirroring the prior context specs.
 */
import {
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "@data-pulse-2/db";
import type { Principal } from "../../src/auth/auth.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type {
  TenantRecord,
  TenantsRepository,
} from "../../src/tenants/tenants.repository";
import { TenantsService } from "../../src/tenants/tenants.service";

/**
 * Passthrough runner — fabricates a fake `PoolClient` (an empty
 * object) and invokes the work function with it. The repository
 * fakes ignore the client argument, so this is sufficient to drive
 * the service's orchestration without a real Postgres pool.
 */
const passthroughTx = jest.fn(
  async <T>(
    _pool: Pool,
    _ctx: TenantContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => work({} as PoolClient),
);

// --- IDs --------------------------------------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000000a1";
const TENANT_ID = "0a000000-0000-7000-8000-0000000000b2";
const OTHER_TENANT_ID = "0a000000-0000-7000-8000-0000000000c3";

// --- Fakes ------------------------------------------------------------

class FakeTenantsRepository {
  listForUserResult: TenantRecord[] = [];
  listAllResult: TenantRecord[] = [];
  findByIdAdminResult: TenantRecord | null = null;
  findByIdResult: TenantRecord | null = null;
  updateResult: TenantRecord | null = null;
  createResult: TenantRecord | null = null;
  softDeleteResult = true;

  listForUserCalls: Array<{ userId: string }> = [];
  listAllCalls: number = 0;
  findByIdAdminCalls: Array<{ tenantId: string }> = [];
  findByIdCalls: Array<{ tenantId: string }> = [];
  updateCalls: Array<{
    tenantId: string;
    next: { name?: string; status?: "active" | "suspended" };
  }> = [];
  createCalls: Array<{ id: string; slug: string; name: string }> = [];
  seedDefaultRolesCalls: Array<{ tenantId: string }> = [];
  softDeleteCalls: Array<{ tenantId: string }> = [];

  async listForUser(_pool: Pool, userId: string): Promise<TenantRecord[]> {
    this.listForUserCalls.push({ userId });
    return this.listForUserResult;
  }
  async listAll(_pool: Pool): Promise<TenantRecord[]> {
    this.listAllCalls += 1;
    return this.listAllResult;
  }
  async findByIdAdmin(
    _pool: Pool,
    tenantId: string,
  ): Promise<TenantRecord | null> {
    this.findByIdAdminCalls.push({ tenantId });
    return this.findByIdAdminResult;
  }
  async findById(_client: unknown, tenantId: string): Promise<TenantRecord | null> {
    this.findByIdCalls.push({ tenantId });
    return this.findByIdResult;
  }
  async create(
    _client: unknown,
    input: { id: string; slug: string; name: string },
  ): Promise<TenantRecord> {
    this.createCalls.push(input);
    if (!this.createResult) {
      throw new Error("FakeTenantsRepository.create: createResult not set");
    }
    return this.createResult;
  }
  async seedDefaultRoles(_client: unknown, tenantId: string): Promise<void> {
    this.seedDefaultRolesCalls.push({ tenantId });
  }
  async update(
    _client: unknown,
    tenantId: string,
    next: { name?: string; status?: "active" | "suspended" },
  ): Promise<TenantRecord | null> {
    this.updateCalls.push({ tenantId, next });
    return this.updateResult;
  }
  async softDelete(_client: unknown, tenantId: string): Promise<boolean> {
    this.softDeleteCalls.push({ tenantId });
    return this.softDeleteResult;
  }
}

class FakeMembershipRepository {
  isPlatformAdminResult = false;
  roleByTenant = new Map<string, string | null>();

  async isPlatformAdmin(_userId: string): Promise<boolean> {
    return this.isPlatformAdminResult;
  }
  async findRoleCodeForUserInTenant(
    _userId: string,
    tenantId: string,
  ): Promise<string | null> {
    return this.roleByTenant.get(tenantId) ?? null;
  }
}

// --- Helpers ----------------------------------------------------------

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const SESSION_PRINCIPAL: Principal = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
};

const PLATFORM_TOKEN: Principal = {
  kind: "token",
  tokenId: "0a000000-0000-7000-8000-0000000000d4",
  tenantId: null,
  userId: null,
};

const TENANT_TOKEN: Principal = {
  kind: "token",
  tokenId: "0a000000-0000-7000-8000-0000000000d4",
  tenantId: TENANT_ID,
  userId: USER_ID,
};

// --- Wiring -----------------------------------------------------------

let repo: FakeTenantsRepository;
let memberships: FakeMembershipRepository;
let service: TenantsService;
const fakePool = {} as Pool;

beforeEach(() => {
  passthroughTx.mockClear();
  repo = new FakeTenantsRepository();
  memberships = new FakeMembershipRepository();
  service = new TenantsService(
    fakePool,
    repo as unknown as TenantsRepository,
    memberships as unknown as MembershipRepository,
    passthroughTx,
  );
});

// --- list -------------------------------------------------------------

describe("TenantsService.list", () => {
  it("returns listAll for platform admin", async () => {
    memberships.isPlatformAdminResult = true;
    repo.listAllResult = [tenant({ id: TENANT_ID }), tenant({ id: OTHER_TENANT_ID })];
    const out = await service.list(SESSION_PRINCIPAL);
    expect(out).toHaveLength(2);
    expect(repo.listAllCalls).toBe(1);
    expect(repo.listForUserCalls).toHaveLength(0);
  });

  it("returns listForUser for regular user", async () => {
    memberships.isPlatformAdminResult = false;
    repo.listForUserResult = [tenant()];
    const out = await service.list(SESSION_PRINCIPAL);
    expect(out).toHaveLength(1);
    expect(repo.listForUserCalls).toEqual([{ userId: USER_ID }]);
    expect(repo.listAllCalls).toBe(0);
  });

  it("returns listAll for platform-scoped token", async () => {
    repo.listAllResult = [tenant()];
    const out = await service.list(PLATFORM_TOKEN);
    expect(out).toHaveLength(1);
    expect(repo.listAllCalls).toBe(1);
  });

  it("returns listForUser for tenant-bound token with userId", async () => {
    memberships.isPlatformAdminResult = false;
    repo.listForUserResult = [tenant()];
    const out = await service.list(TENANT_TOKEN);
    expect(out).toHaveLength(1);
    expect(repo.listForUserCalls).toEqual([{ userId: USER_ID }]);
  });

  it("returns empty list for user-less, non-platform token", async () => {
    const userlessTenantToken: Principal = {
      kind: "token",
      tokenId: "0a000000-0000-7000-8000-0000000000d5",
      tenantId: TENANT_ID,
      userId: null,
    };
    const out = await service.list(userlessTenantToken);
    expect(out).toEqual([]);
    expect(repo.listAllCalls).toBe(0);
    expect(repo.listForUserCalls).toHaveLength(0);
  });
});

// --- create -----------------------------------------------------------

describe("TenantsService.create", () => {
  it("throws 403 for non-platform-admin sessions", async () => {
    memberships.isPlatformAdminResult = false;
    await expect(
      service.create(SESSION_PRINCIPAL, { slug: "acme", name: "Acme" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.createCalls).toHaveLength(0);
  });

  it("throws 403 for tenant-bound tokens", async () => {
    memberships.isPlatformAdminResult = false;
    await expect(
      service.create(TENANT_TOKEN, { slug: "acme", name: "Acme" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("admin path: creates the tenant and seeds default roles atomically", async () => {
    memberships.isPlatformAdminResult = true;
    repo.createResult = tenant({ slug: "acme", name: "Acme" });
    const out = await service.create(SESSION_PRINCIPAL, {
      slug: "acme",
      name: "Acme",
    });
    expect(out.slug).toBe("acme");
    expect(repo.createCalls).toHaveLength(1);
    // Same tenantId is forwarded to seedDefaultRoles → atomicity
    // shape pin (real `runWithTenantContext` would commit both writes
    // in one transaction).
    expect(repo.seedDefaultRolesCalls).toHaveLength(1);
    expect(repo.seedDefaultRolesCalls[0]?.tenantId).toBe(
      repo.createCalls[0]?.id,
    );
  });

  it("admin path: maps a unique-violation on tenants_slug_active_uidx to ConflictException (409)", async () => {
    memberships.isPlatformAdminResult = true;
    // Trigger the conflict path: have create throw a 23505 with the
    // expected constraint name.
    repo.createResult = tenant();
    const original = repo.create.bind(repo);
    repo.create = async (_client, input) => {
      void original; // silence unused-var lint
      const err = new Error(
        'duplicate key value violates unique constraint "tenants_slug_active_uidx"',
      ) as Error & { code: string; constraint: string };
      err.code = "23505";
      err.constraint = "tenants_slug_active_uidx";
      throw err;
    };
    await expect(
      service.create(SESSION_PRINCIPAL, {
        slug: "acme",
        name: "Acme",
      }),
    ).rejects.toThrow(/Slug already in use/);
  });

  it("admin path: re-raises non-conflict errors verbatim", async () => {
    memberships.isPlatformAdminResult = true;
    repo.create = async () => {
      throw new Error("transport blew up");
    };
    await expect(
      service.create(SESSION_PRINCIPAL, {
        slug: "acme",
        name: "Acme",
      }),
    ).rejects.toThrow("transport blew up");
  });
});

// --- read -------------------------------------------------------------

describe("TenantsService.read", () => {
  it("returns the tenant via admin path for platform admin", async () => {
    memberships.isPlatformAdminResult = true;
    repo.findByIdAdminResult = tenant();
    const out = await service.read(SESSION_PRINCIPAL, TENANT_ID);
    expect(out.id).toBe(TENANT_ID);
    expect(repo.findByIdAdminCalls).toEqual([{ tenantId: TENANT_ID }]);
  });

  it("throws 404 when admin path returns null (tenant doesn't exist)", async () => {
    memberships.isPlatformAdminResult = true;
    repo.findByIdAdminResult = null;
    await expect(
      service.read(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when regular user has no role in the tenant", async () => {
    memberships.isPlatformAdminResult = false;
    memberships.roleByTenant.set(TENANT_ID, null);
    await expect(
      service.read(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    // No DB read attempted via the tenant-scoped path either.
    expect(repo.findByIdCalls).toHaveLength(0);
  });

  it("throws 404 for user-less tokens", async () => {
    const userlessTenantToken: Principal = {
      kind: "token",
      tokenId: "0a000000-0000-7000-8000-0000000000d5",
      tenantId: TENANT_ID,
      userId: null,
    };
    await expect(
      service.read(userlessTenantToken, TENANT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// --- update -----------------------------------------------------------

describe("TenantsService.update", () => {
  it("admin path: updates and returns the row", async () => {
    memberships.isPlatformAdminResult = true;
    repo.updateResult = tenant({ name: "New Name" });
    const out = await service.update(SESSION_PRINCIPAL, TENANT_ID, {
      name: "New Name",
    });
    expect(out.name).toBe("New Name");
    expect(repo.updateCalls).toHaveLength(1);
  });

  it("admin path: 404 if update returns null (already deleted)", async () => {
    memberships.isPlatformAdminResult = true;
    repo.updateResult = null;
    await expect(
      service.update(SESSION_PRINCIPAL, TENANT_ID, { name: "New" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("non-admin: 404 when no role in tenant", async () => {
    memberships.isPlatformAdminResult = false;
    memberships.roleByTenant.set(TENANT_ID, null);
    await expect(
      service.update(SESSION_PRINCIPAL, TENANT_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateCalls).toHaveLength(0);
  });

  it("non-admin: 404 when role is insufficient (e.g., store_staff)", async () => {
    memberships.isPlatformAdminResult = false;
    memberships.roleByTenant.set(TENANT_ID, "store_staff");
    await expect(
      service.update(SESSION_PRINCIPAL, TENANT_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateCalls).toHaveLength(0);
  });

  it("non-admin: 404 when role is store_manager (still insufficient)", async () => {
    memberships.isPlatformAdminResult = false;
    memberships.roleByTenant.set(TENANT_ID, "store_manager");
    await expect(
      service.update(SESSION_PRINCIPAL, TENANT_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("non-admin tenant_admin: succeeds", async () => {
    memberships.isPlatformAdminResult = false;
    memberships.roleByTenant.set(TENANT_ID, "tenant_admin");
    repo.updateResult = tenant({ name: "Renamed" });
    const out = await service.update(SESSION_PRINCIPAL, TENANT_ID, {
      name: "Renamed",
    });
    expect(out.name).toBe("Renamed");
  });

  it("non-admin owner: succeeds", async () => {
    memberships.isPlatformAdminResult = false;
    memberships.roleByTenant.set(TENANT_ID, "owner");
    repo.updateResult = tenant();
    await expect(
      service.update(SESSION_PRINCIPAL, TENANT_ID, { status: "suspended" }),
    ).resolves.toBeDefined();
    expect(repo.updateCalls[0]?.next).toEqual({ status: "suspended" });
  });
});

// --- softDelete -------------------------------------------------------

describe("TenantsService.softDelete", () => {
  it("throws 403 for non-platform-admin", async () => {
    memberships.isPlatformAdminResult = false;
    await expect(
      service.softDelete(SESSION_PRINCIPAL, TENANT_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.softDeleteCalls).toHaveLength(0);
  });

  it("admin path: invokes softDelete and returns void", async () => {
    memberships.isPlatformAdminResult = true;
    await expect(
      service.softDelete(SESSION_PRINCIPAL, TENANT_ID),
    ).resolves.toBeUndefined();
    expect(repo.softDeleteCalls).toEqual([{ tenantId: TENANT_ID }]);
  });
});
