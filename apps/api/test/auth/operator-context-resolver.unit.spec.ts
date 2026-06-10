/**
 * operator-context-resolver.unit.spec.ts — 008 Option Y.
 *
 * Docker-free unit coverage for PgOperatorContextResolver — the security core
 * of the sale-auth path. Every branch of the Clerk-verify → user → device →
 * membership → role/store eligibility derivation is asserted with fakes for
 * `pool.query`, the ClerkVerifier, and the DeviceRepository. No NestJS module,
 * no Testcontainers, no network.
 *
 * The end-to-end SQL-against-real-schema proof lives in the testcontainer
 * integration spec (sale-auth.integration.spec.ts); this spec proves the
 * decision logic + the typed refusal taxonomy.
 */
import "reflect-metadata";

import type { Pool } from "pg";
import type { DeviceRow } from "@data-pulse-2/db/schema";

import {
  PgOperatorContextResolver,
} from "../../src/auth/operator-context-resolver";
import type { ClerkVerifier } from "../../src/pos-operators/clerk-verifier";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";

const SUB = "user_clerk_sub_123";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const DEVICE_ID = "0a000000-0000-7000-8000-0000000dev01";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-0000000mem01";

function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    revokedAt: null,
    ...overrides,
  } as unknown as DeviceRow;
}

interface UserRow {
  id: string;
  deleted_at: Date | null;
}
interface MembershipRow {
  id: string;
  store_access_kind: "all" | "specific";
  revoked_at: Date | null;
  deleted_at: Date | null;
  role_code: string;
}

/**
 * Build a resolver with scripted dependencies. `userRow` / `membershipRow`
 * drive the two `pool.query` calls (user lookup, membership lookup); a third
 * query (store_access) returns `storeAccessRows`.
 */
function build(opts: {
  verify?: () => Promise<{ sub: string }>;
  device?: DeviceRow | null;
  userRow?: UserRow | null;
  membershipRow?: MembershipRow | null;
  storeAccessRows?: Array<{ one: number }>;
}) {
  const verifier: ClerkVerifier = {
    verify: opts.verify ?? (async () => ({ sub: SUB })),
  };
  const deviceRepository = {
    findActiveByAttestation: jest.fn().mockResolvedValue(
      opts.device === undefined ? makeDevice() : opts.device,
    ),
  } as unknown as DeviceRepository;

  const query = jest.fn((sql: string) => {
    const text = String(sql);
    if (text.includes("FROM users")) {
      return Promise.resolve({
        rows: opts.userRow === undefined
          ? [{ id: USER_ID, deleted_at: null }]
          : opts.userRow === null
            ? []
            : [opts.userRow],
      });
    }
    if (text.includes("FROM memberships")) {
      return Promise.resolve({
        rows: opts.membershipRow === undefined
          ? [{
              id: MEMBERSHIP_ID,
              store_access_kind: "all",
              revoked_at: null,
              deleted_at: null,
              role_code: "store_manager",
            }]
          : opts.membershipRow === null
            ? []
            : [opts.membershipRow],
      });
    }
    if (text.includes("FROM store_access")) {
      return Promise.resolve({ rows: opts.storeAccessRows ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const pool = { query } as unknown as Pool;

  return new PgOperatorContextResolver(pool, verifier, deviceRepository);
}

describe("PgOperatorContextResolver — refusals (security branches)", () => {
  it("clerk verify throws → clerk_jwt_invalid", async () => {
    const r = build({ verify: async () => { throw new Error("bad jwt"); } });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "clerk_jwt_invalid" });
  });

  it("no local user for sub → user_unmapped", async () => {
    const r = build({ userRow: null });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "user_unmapped" });
  });

  it("soft-deleted user → user_disabled", async () => {
    const r = build({ userRow: { id: USER_ID, deleted_at: new Date("2026-01-01") } });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "user_disabled" });
  });

  it("no active device for attestation → device_invalid", async () => {
    const r = build({ device: null });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "device_invalid" });
  });

  it("no membership in device tenant → membership_missing", async () => {
    const r = build({ membershipRow: null });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "membership_missing" });
  });

  it("revoked membership → membership_revoked", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "all",
        revoked_at: new Date("2026-01-01"), deleted_at: null, role_code: "store_manager",
      },
    });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "membership_revoked" });
  });

  it("ineligible role (store_staff/cashier) → role_ineligible", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "all",
        revoked_at: null, deleted_at: null, role_code: "store_staff",
      },
    });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "role_ineligible" });
  });

  it("specific store access with device store NOT in set → store_not_in_access_set", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "specific",
        revoked_at: null, deleted_at: null, role_code: "store_manager",
      },
      storeAccessRows: [], // not in set
    });
    expect(await r.resolve("jwt", "att")).toEqual({
      kind: "refused", reason: "store_not_in_access_set",
    });
  });
});

describe("PgOperatorContextResolver — happy path", () => {
  it("eligible store_manager, access=all → ok with context scoped FROM the device row", async () => {
    const r = build({}); // all defaults: valid user, active device, store_manager/all
    const result = await r.resolve("jwt", "att");
    expect(result).toEqual({
      kind: "ok",
      context: {
        userId: USER_ID,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        isPlatformAdmin: false,
        source: "token",
      },
    });
  });

  it("specific store access WITH device store in set → ok", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "specific",
        revoked_at: null, deleted_at: null, role_code: "store_manager",
      },
      storeAccessRows: [{ one: 1 }], // in set
    });
    const result = await r.resolve("jwt", "att");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.context.storeId).toBe(STORE_ID);
  });

  it("owner and tenant_admin roles are eligible", async () => {
    for (const role of ["owner", "tenant_admin"]) {
      const r = build({
        membershipRow: {
          id: MEMBERSHIP_ID, store_access_kind: "all",
          revoked_at: null, deleted_at: null, role_code: role,
        },
      });
      const result = await r.resolve("jwt", "att");
      expect(result.kind).toBe("ok");
    }
  });
});
