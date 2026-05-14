/**
 * T264 [US7] [SC-8] — POS-seam walkthrough test.
 *
 * SC-8 requires the foundation to be reusable for POS without schema changes.
 * This file is the executable companion to docs/pos-seam-walkthrough.md.
 *
 * Strategy — Docker-free, unit-level:
 *   Construct an in-memory hypothetical POS order submission and walk it
 *   through the five foundation seams using only existing primitives:
 *
 *     Seam 1  Tenant/store scoping    — TenantContextGuard.resolve()
 *     Seam 2  Device-bound tokens     — kind:"token" principal with deviceId note
 *     Seam 3  Idempotency key store   — IdempotencyKeyStore.findOrCreate/save
 *     Seam 4  Namespace reservation   — covered by T263; referenced here
 *     Seam 5  RLS isolation           — covered by T207; assertion in schema check
 *
 *   No production code is added. No POS endpoint is created. No schema
 *   migration is written. The DB schema barrel is key-checked inline to prove
 *   no POS/order table was added by this seam groundwork.
 *
 * Note on principal kind: today's Principal type supports "session" and
 * "token" only. A future `kind: "pos-device"` principal would be production
 * code and is explicitly out of scope for this seam slice. The walkthrough
 * therefore uses `kind: "token"` (bearer token bound to a device row) with
 * `tenantId` baked at issuance. The token principal resolves `storeId: null`
 * today — storeId rides the request body for POS calls (as shown below).
 */

import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { MembershipRepository } from "../../src/context/membership.repository";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import {
  type FindOrCreateResult,
  type IdempotencyEntry,
  IdempotencyKeyStore,
  type PgMirrorReader,
  type PgMirrorWriter,
  type RedisLike,
  type StoredResult,
} from "@data-pulse-2/shared";
import * as schema from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Stable UUIDs — hypothetical POS request
// ---------------------------------------------------------------------------

const TENANT_ID = "0b000000-0000-7000-8000-000000ten001";
const STORE_ID = "0b000000-0000-7000-8000-000000sto001";
const DEVICE_ID = "0b000000-0000-7000-8000-000000dev001";
const TOKEN_ID = "0b000000-0000-7000-8000-000000tok001";
const USER_ID = null; // device-bound token: no user, device_id set instead
const IDEMPOTENCY_KEY = "receipt-20260514-001";
const FINGERPRINT = Buffer.from("abcd1234abcd1234", "hex");

// ---------------------------------------------------------------------------
// Seam 1 fakes — TenantContextGuard collaborators
// ---------------------------------------------------------------------------

class FakeSessionRepository {
  async findActiveById(_id: string): ReturnType<SessionRepository["findActiveById"]> {
    return null;
  }
}

class FakeMembershipRepository {
  async isPlatformAdmin(_userId: string): Promise<boolean> {
    return false;
  }
  async findActiveMembership(
    _userId: string,
    _tenantId: string,
  ): Promise<{ membershipId: string; storeAccessKind: "all" | "specific" } | null> {
    return null;
  }
  async canAccessStore(
    _membershipId: string,
    _tenantId: string,
    _storeId: string,
    _kind: "all" | "specific",
  ): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Seam 3 fakes — IdempotencyKeyStore collaborators
// ---------------------------------------------------------------------------

function makeRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function makePgWriter(): PgMirrorWriter & { calls: Array<Parameters<PgMirrorWriter["insert"]>[0]> } {
  const calls: Array<Parameters<PgMirrorWriter["insert"]>[0]> = [];
  return {
    calls,
    async insert(row) {
      calls.push(row);
    },
  };
}

// ---------------------------------------------------------------------------
// Seam 5 — Schema barrel helper
// ---------------------------------------------------------------------------

/** Returns sorted export names from the DB schema barrel. */
function schemaExportNames(): string[] {
  return Object.keys(schema).sort();
}

// ---------------------------------------------------------------------------
// SC-8 Seam 1 + 2 — TenantContextGuard resolves a device-bound token principal
// ---------------------------------------------------------------------------

describe("[SC-8] Seam 1+2 — token principal resolves tenant context without a membership query", () => {
  let guard: TenantContextGuard;

  beforeEach(() => {
    guard = new TenantContextGuard(
      new FakeSessionRepository() as unknown as SessionRepository,
      new FakeMembershipRepository() as unknown as MembershipRepository,
      // no pool — unit-test path
    );
  });

  it("resolves tenantId from a token principal (device-bound bearer token path)", async () => {
    // Today's token principal carries tenantId baked at issuance; storeId is
    // null because the current Principal type doesn't carry a store binding.
    // A future `kind: "pos-device"` slice will add storeId here.
    const principal: Principal = {
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      scope: "pos",
    };

    const ctx: ResolvedContext = await guard.resolve(principal);

    expect(ctx.tenantId).toBe(TENANT_ID);
    expect(ctx.storeId).toBeNull(); // storeId rides request body today
    expect(ctx.isPlatformAdmin).toBe(false);
    expect(ctx.source).toBe("token");
  });

  it("does NOT consult session or membership repositories for a token principal (Seam 2 — fast path)", async () => {
    const sessions = new FakeSessionRepository();
    const memberships = new FakeMembershipRepository();
    const findActiveByIdSpy = jest.spyOn(sessions, "findActiveById");
    const isPlatformAdminSpy = jest.spyOn(memberships, "isPlatformAdmin");
    const findActiveMembershipSpy = jest.spyOn(memberships, "findActiveMembership");

    const g = new TenantContextGuard(
      sessions as unknown as SessionRepository,
      memberships as unknown as MembershipRepository,
    );

    const principal: Principal = {
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      scope: "pos",
    };

    await g.resolve(principal);

    expect(findActiveByIdSpy).not.toHaveBeenCalled();
    expect(isPlatformAdminSpy).not.toHaveBeenCalled();
    expect(findActiveMembershipSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SC-8 Seam 3 — IdempotencyKeyStore: first write then duplicate replay
// ---------------------------------------------------------------------------

describe("[SC-8] Seam 3 — IdempotencyKeyStore covers the first-write / duplicate-replay cycle", () => {
  const IDEMPOTENCY_RESULT: StoredResult = { status: 201, body: { receiptId: "r-001" } };
  const NOW = new Date("2026-05-14T10:00:00.000Z");
  const EXPIRES_AT = new Date("2026-05-15T10:00:00.000Z"); // +24h

  it("first write: findOrCreate returns miss, save persists to Redis + Postgres mirror", async () => {
    const redis = makeRedis();
    const pgWriter = makePgWriter();
    const pgReader: PgMirrorReader = {
      async find() {
        return null;
      },
    };
    const enqueue = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);

    const store = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader,
      clock: () => NOW,
    });

    // Step 1: check for prior result — must be a miss (first ever call)
    const before: FindOrCreateResult = await store.findOrCreate(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );
    expect(before.hit).toBe(false);

    // Step 2: process the request (simulated), then enqueue follow-on work
    await enqueue({ tenantId: TENANT_ID, storeId: STORE_ID });

    // Step 3: persist the response
    await store.save(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      IDEMPOTENCY_RESULT,
      EXPIRES_AT,
    );

    // Assertions — enqueued exactly once
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Redis received the serialized entry
    expect(redis.store.size).toBe(1);

    // Postgres mirror received the insert call with the correct fields
    expect(pgWriter.calls).toHaveLength(1);
    const written = pgWriter.calls[0]!;
    expect(written.tenantId).toBe(TENANT_ID);
    expect(written.storeId).toBe(STORE_ID);
    expect(written.clientId).toBe(DEVICE_ID);
    expect(written.key).toBe(IDEMPOTENCY_KEY);
    expect(written.fingerprint.equals(FINGERPRINT)).toBe(true);
    expect(written.result).toEqual(IDEMPOTENCY_RESULT);
    expect(written.expiresAt).toEqual(EXPIRES_AT);
  });

  it("duplicate replay: findOrCreate returns Redis hit for same fingerprint — enqueue is NOT called again", async () => {
    const redis = makeRedis();
    const pgWriter = makePgWriter();
    const pgReader: PgMirrorReader = {
      async find() {
        return null;
      },
    };
    const enqueue = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);

    const store = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader,
      clock: () => NOW,
    });

    // Seed: first write already happened
    await store.save(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      IDEMPOTENCY_RESULT,
      EXPIRES_AT,
    );

    // Retry arrives — findOrCreate must return a hit
    const retry: FindOrCreateResult = await store.findOrCreate(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );

    // Caller inspects the hit and skips enqueueing — simulated below
    if (!retry.hit) {
      // miss: would enqueue (should NOT reach here in this test)
      await enqueue({ tenantId: TENANT_ID, storeId: STORE_ID });
    }
    // hit: return cached result without calling enqueue

    expect(retry.hit).toBe(true);
    if (retry.hit === true) {
      expect(retry.entry.result).toEqual(IDEMPOTENCY_RESULT);
      expect(retry.entry.fingerprint.equals(FINGERPRINT)).toBe(true);
    }

    // The key behavioral proof: duplicate replay must NOT re-enqueue
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("collision: findOrCreate returns { hit: 'collision' } when fingerprint differs", async () => {
    const redis = makeRedis();
    const pgWriter = makePgWriter();
    const pgReader: PgMirrorReader = {
      async find() {
        return null;
      },
    };

    const store = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader,
      clock: () => NOW,
    });

    // Store a result with the original fingerprint
    await store.save(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      IDEMPOTENCY_RESULT,
      EXPIRES_AT,
    );

    // Retry arrives with a DIFFERENT fingerprint (body was mutated — collision)
    const differentFingerprint = Buffer.from("deadbeefdeadbeef", "hex");
    const collision: FindOrCreateResult = await store.findOrCreate(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      differentFingerprint,
    );

    expect(collision.hit).toBe("collision");
  });

  it("expired entry: findOrCreate returns miss when TTL has elapsed", async () => {
    const redis = makeRedis();
    const pgWriter = makePgWriter();

    const PAST = new Date("2026-05-10T00:00:00.000Z");
    const ALREADY_EXPIRED = new Date("2026-05-13T00:00:00.000Z"); // before NOW

    const storeAtPast = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader: { async find() { return null; } },
      clock: () => PAST,
    });

    await storeAtPast.save(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      IDEMPOTENCY_RESULT,
      ALREADY_EXPIRED,
    );

    // Now read with clock advanced past expiry
    const storeAtNow = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader: { async find() { return null; } },
      clock: () => NOW,
    });

    const result: FindOrCreateResult = await storeAtNow.findOrCreate(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );

    expect(result.hit).toBe(false);
  });

  it("tenant isolation: different tenantId produces a cache miss even for the same key", async () => {
    const redis = makeRedis();
    const pgWriter = makePgWriter();
    const pgReader: PgMirrorReader = {
      async find() {
        return null;
      },
    };

    const store = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader,
      clock: () => NOW,
    });

    const OTHER_TENANT = "0b000000-0000-7000-8000-000000ten999";

    await store.save(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      IDEMPOTENCY_RESULT,
      EXPIRES_AT,
    );

    // Same key, different tenant → Redis key differs → must miss
    const result: FindOrCreateResult = await store.findOrCreate(
      OTHER_TENANT,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );

    expect(result.hit).toBe(false);
  });

  it("Postgres mirror fallback: when Redis is cold, pgReader is consulted", async () => {
    const coldRedis = makeRedis(); // empty — will always miss
    const pgWriter = makePgWriter();

    const storedEntry: IdempotencyEntry = {
      fingerprint: FINGERPRINT,
      result: IDEMPOTENCY_RESULT,
      expiresAt: EXPIRES_AT,
    };

    const pgReader: PgMirrorReader = {
      async find() {
        return storedEntry;
      },
    };

    const store = new IdempotencyKeyStore({
      redis: coldRedis,
      pgWriter,
      pgReader,
      clock: () => NOW,
    });

    const result: FindOrCreateResult = await store.findOrCreate(
      TENANT_ID,
      STORE_ID,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );

    expect(result.hit).toBe(true);
    if (result.hit === true) {
      expect(result.entry.result).toEqual(IDEMPOTENCY_RESULT);
    }
  });
});

// ---------------------------------------------------------------------------
// SC-8 Seam 5 — DB schema barrel: no POS/order table added
// ---------------------------------------------------------------------------

describe("[SC-8] Seam 5 — DB schema barrel contains no POS-domain tables", () => {
  it("exports the expected 15 foundation table constants", () => {
    const exported = schemaExportNames();

    // Every foundation table must be present
    const required = [
      "auditEvents",
      "authTokens",
      "devices",
      "idempotencyKeys",
      "invitations",
      "memberships",
      "permissions",
      "rolePermissions",
      "roles",
      "sessions",
      "shifts",
      "storeAccess",
      "stores",
      "tenants",
      "users",
    ];
    for (const name of required) {
      expect(exported).toContain(name);
    }
  });

  it("does NOT export any POS-domain sale, receipt, order, or line-item tables (SC-8 guard rail)", () => {
    const exported = schemaExportNames();

    // These names would indicate a schema change snuck in without approval.
    // The list is deliberately broad to catch naming variants.
    const forbidden = [
      "posSales",
      "posReceipts",
      "posOrders",
      "posLineItems",
      "posItems",
      "salesLines",
      "saleLines",
      "receiptLines",
      "orderLines",
      "orders",
      "receipts",
      "sales",
    ];
    for (const name of forbidden) {
      expect(exported).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// SC-8 End-to-end walkthrough narrative: full seam chain in one test
// ---------------------------------------------------------------------------

describe("[SC-8] End-to-end walkthrough — hypothetical POS receipt submission", () => {
  it("chains all seams: context resolution → idempotency miss → save → replay hit", async () => {
    // ── Seam 1+2: resolve tenant context from device-bound token principal ──
    const guard = new TenantContextGuard(
      new FakeSessionRepository() as unknown as SessionRepository,
      new FakeMembershipRepository() as unknown as MembershipRepository,
    );

    const devicePrincipal: Principal = {
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      scope: "pos",
    };

    const ctx = await guard.resolve(devicePrincipal);
    // storeId comes from the request body (token limitation today)
    const effectiveTenantId = ctx.tenantId!;
    const effectiveStoreId = STORE_ID; // from request body

    // ── Seam 3: idempotency — first call ────────────────────────────────────
    const redis = makeRedis();
    const pgWriter = makePgWriter();
    const pgReader: PgMirrorReader = { async find() { return null; } };
    const enqueue = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
    const NOW = new Date("2026-05-14T10:00:00.000Z");
    const EXPIRES_AT = new Date("2026-05-15T10:00:00.000Z");
    const RESULT: StoredResult = { status: 201, body: { receiptId: "r-walk-001" } };

    const idempotencyStore = new IdempotencyKeyStore({
      redis,
      pgWriter,
      pgReader,
      clock: () => NOW,
    });

    const firstCheck = await idempotencyStore.findOrCreate(
      effectiveTenantId,
      effectiveStoreId,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );

    expect(firstCheck.hit).toBe(false); // first ever call: miss

    // ── Follow-on work (simulated — Seam 4 namespace + future service) ──────
    await enqueue({ tenantId: effectiveTenantId, storeId: effectiveStoreId });
    expect(enqueue).toHaveBeenCalledTimes(1);

    // ── Persist the response ────────────────────────────────────────────────
    await idempotencyStore.save(
      effectiveTenantId,
      effectiveStoreId,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
      RESULT,
      EXPIRES_AT,
    );

    // ── Seam 3: idempotency — duplicate retry ───────────────────────────────
    const retryCheck = await idempotencyStore.findOrCreate(
      effectiveTenantId,
      effectiveStoreId,
      DEVICE_ID,
      IDEMPOTENCY_KEY,
      FINGERPRINT,
    );

    expect(retryCheck.hit).toBe(true);
    if (retryCheck.hit === true) {
      // Caller returns the cached response
      expect(retryCheck.entry.result.status).toBe(201);
    }

    // ── Proof: follow-on work was NOT repeated ──────────────────────────────
    expect(enqueue).toHaveBeenCalledTimes(1); // still 1, not 2
  });
});
