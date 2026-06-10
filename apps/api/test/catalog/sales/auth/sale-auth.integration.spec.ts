/**
 * sale-auth.integration.spec.ts — 008 Option Y.
 *
 * Real Postgres via Testcontainers (all migrations applied). Mounts the REAL
 * SalesModule — the real PosOperatorSaleAuthGuard + PgOperatorContextResolver
 * run; only the ClerkVerifier seam is overridden with a deterministic fake
 * (raw JWT → Clerk subject) so no traffic reaches Clerk's JWKS.
 *
 * This is the proof the resolver's hand-written SQL is valid against the live
 * schema AND that Express has populated `request.body` by guard-time (the guard
 * reads `request.body.deviceTokenAttestation` directly, before the Zod pipe).
 * The docker-free unit specs cover the decision branches; this covers the wire.
 *
 * Seeding mirrors `test/pos-operators/pos-operators.controller.spec.ts`
 * verbatim (the sign-in surface runs the same identity/eligibility resolution),
 * adapting only IDs.
 *
 * Coverage:
 *   - Happy: store_manager (access=all) → 201 with a SaleProjection scoped to
 *     the device's store; the sale row is written under the device tenant.
 *   - Refusal → uniform 401: missing Authorization, missing body attestation,
 *     unmapped Clerk subject, soft-deleted user, revoked device, ineligible
 *     role (store_staff), specific-access without grant.
 *
 * NOTE: CI runs Testcontainers (ci.yml pulls postgres:16-alpine; never sets
 * MIGRATION_TEST_ALLOW_SKIP). Locally without Docker this suite skips.
 */
import "reflect-metadata";

import { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import { Pool } from "pg";
import request from "supertest";

import { SalesController } from "../../../../src/catalog/sales/sales.controller";
import { SalesService } from "../../../../src/catalog/sales/sales.service";
import {
  CLERK_VERIFIER,
  type ClerkVerifier,
} from "../../../../src/pos-operators/clerk-verifier";
import { DeviceRepository } from "../../../../src/pos-operators/device.repository";
import {
  OPERATOR_CONTEXT_RESOLVER,
  PgOperatorContextResolver,
} from "../../../../src/auth/operator-context-resolver";
import { PosOperatorSaleAuthGuard } from "../../../../src/auth/pos-operator-sale-auth.guard";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { ZodValidationPipe } from "../../../../src/common/zod-validation.pipe";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";

const TENANT_ID = "0d000000-0000-4000-8000-000000000001";
const STORE_ID = "0d000000-0000-4000-8000-00000000aa01";
const STORE_ID_OTHER = "0d000000-0000-4000-8000-00000000aa02";

const MANAGER_ROLE_ID = "0d000000-0000-4000-8000-00000000bb01";
const STAFF_ROLE_ID = "0d000000-0000-4000-8000-00000000bb02";

const MGR_USER_ID = "0d000000-0000-4000-8000-00000000cc01";
const MGR_SUB = "user_clerk_mgr_saleauth";
const STAFF_USER_ID = "0d000000-0000-4000-8000-00000000cc02";
const STAFF_SUB = "user_clerk_staff_saleauth";
const SPECIFIC_USER_ID = "0d000000-0000-4000-8000-00000000cc03";
const SPECIFIC_SUB = "user_clerk_specific_saleauth";
const DELETED_USER_ID = "0d000000-0000-4000-8000-00000000cc04";
const DELETED_SUB = "user_clerk_deleted_saleauth";

const MGR_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd01";
const STAFF_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd02";
const SPECIFIC_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd03";
const DELETED_MEMBERSHIP_ID = "0d000000-0000-4000-8000-00000000dd04";

const DEVICE_ID = "0d000000-0000-4000-8000-00000000ee01";
const DEVICE_REVOKED_ID = "0d000000-0000-4000-8000-00000000ee02";
const DEVICE_ATTESTATION = "device-saleauth-attestation";
const DEVICE_REVOKED_ATTESTATION = "device-saleauth-revoked-attestation";

class StubClerkVerifier implements ClerkVerifier {
  constructor(private readonly map: Map<string, string>) {}
  async verify(rawJwt: string): Promise<{ sub: string }> {
    const sub = this.map.get(rawJwt);
    if (!sub) throw new Error("StubClerkVerifier: unknown jwt");
    return { sub };
  }
}

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> { return true; }
  async del(): Promise<void> {}
}

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

function maybeSkip(): boolean {
  return dockerSkipped;
}
function http() {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}

function captureBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceTokenAttestation: DEVICE_ATTESTATION,
    sourceSystem: "saleauth-pos",
    externalId: "saleauth-ext-001",
    currencyCode: "USD",
    posTotal: "5.0000",
    occurredAt: "2026-05-01T10:00:00.000Z",
    lines: [
      {
        lineName: "Widget",
        unitPrice: "5.0000",
        currencyCode: "USD",
        quantity: "1",
        lineAmount: "5.0000",
        unit: "ea",
      },
    ],
    ...overrides,
  };
}

let idemCounter = 0;
function idemKey(): string {
  idemCounter += 1;
  return `saleauth-idem-${idemCounter}`.padEnd(20, "0");
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'saleauth-tenant', 'SaleAuth Tenant')`,
      [TENANT_ID],
    );
    await pool.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES
         ($1, $2, 'store_manager', 'Manager'),
         ($3, $2, 'store_staff',   'Staff')`,
      [MANAGER_ROLE_ID, TENANT_ID, STAFF_ROLE_ID],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'STA', 'Store A'),
         ($3, $2, 'STB', 'Store B')`,
      [STORE_ID, TENANT_ID, STORE_ID_OTHER],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
         ($1, 'mgr@saleauth.example',      'Mgr',      $2),
         ($3, 'staff@saleauth.example',    'Staff',    $4),
         ($5, 'specific@saleauth.example', 'Specific', $6)`,
      [MGR_USER_ID, MGR_SUB, STAFF_USER_ID, STAFF_SUB, SPECIFIC_USER_ID, SPECIFIC_SUB],
    );
    await pool.query(
      `INSERT INTO users (id, email, display_name, clerk_user_id, deleted_at)
         VALUES ($1, 'deleted@saleauth.example', 'Deleted', $2, now())`,
      [DELETED_USER_ID, DELETED_SUB],
    );
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
         ($1, $2, $3, $4, 'all'),
         ($5, $2, $6, $7, 'all'),
         ($8, $2, $9, $4, 'specific'),
         ($10, $2, $11, $4, 'all')`,
      [
        MGR_MEMBERSHIP_ID, TENANT_ID, MGR_USER_ID, MANAGER_ROLE_ID,
        STAFF_MEMBERSHIP_ID, STAFF_USER_ID, STAFF_ROLE_ID,
        SPECIFIC_MEMBERSHIP_ID, SPECIFIC_USER_ID,
        DELETED_MEMBERSHIP_ID, DELETED_USER_ID,
      ],
    );
    // The "specific" manager is granted access to the OTHER store only — so a
    // sale on STORE_ID (the device's store) must be refused.
    await pool.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`,
      [SPECIFIC_MEMBERSHIP_ID, STORE_ID_OTHER, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash)
         VALUES ($1, $2, $3, 'till-A', $4)`,
      [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
    );
    await pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
         VALUES ($1, $2, $3, 'till-revoked', $4, now())`,
      [DEVICE_REVOKED_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_REVOKED_ATTESTATION)],
    );

    const verifierMap = new Map<string, string>([
      ["jwt-mgr", MGR_SUB],
      ["jwt-staff", STAFF_SUB],
      ["jwt-specific", SPECIFIC_SUB],
      ["jwt-deleted", DELETED_SUB],
      ["jwt-unmapped", "user_clerk_unmapped_saleauth"],
    ]);

    const fakeRedis = new FakeRedis();
    const idempStore = new IdempotencyKeyStore({
      redis: fakeRedis,
      pgWriter: { async insert() {} },
      pgReader: { async find() { return null; } },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const idempInterceptor = new IdempotencyInterceptor(
      new Reflector(),
      idempStore,
      new FakeMarker() as unknown as InProgressMarker,
    );

    const appPool = pool;
    const moduleRef = await Test.createTestingModule({
      controllers: [SalesController],
      providers: [
        { provide: PG_POOL, useValue: appPool },
        SalesService,
        { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
        { provide: INFLIGHT_REDIS, useValue: fakeRedis },
        { provide: InProgressMarker, useValue: new FakeMarker() },
        { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
        { provide: CLERK_VERIFIER, useValue: new StubClerkVerifier(verifierMap) },
        {
          provide: DeviceRepository,
          useFactory: (p: Pool): DeviceRepository => new DeviceRepository(p),
          inject: [PG_POOL],
        },
        {
          provide: OPERATOR_CONTEXT_RESOLVER,
          useFactory: (
            p: Pool,
            v: ClerkVerifier,
            d: DeviceRepository,
          ): PgOperatorContextResolver => new PgOperatorContextResolver(p, v, d),
          inject: [PG_POOL, CLERK_VERIFIER, DeviceRepository],
        },
        // Bare class — Nest resolves the guard's @Inject(OPERATOR_CONTEXT_RESOLVER).
        PosOperatorSaleAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sale-auth.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (pool) {
    await pool.query("DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'saleauth-pos')");
    await pool.query("DELETE FROM sales WHERE source_system = 'saleauth-pos'");
  }
});

describe("captureSale auth (Option Y) — happy path", () => {
  it("eligible store_manager + valid Clerk JWT + device attestation → 201, sale scoped to device store", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-mgr")
      .set("Idempotency-Key", idemKey())
      .send(captureBody());

    expect(res.status).toBe(201);
    expect(res.body.storeId).toBe(STORE_ID);
    expect(res.body.posTotal).toBe("5.0000");

    // Persisted under the device tenant.
    const n = await pool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales WHERE tenant_id = $1 AND source_system = 'saleauth-pos'`,
      [TENANT_ID],
    );
    expect(n.rows[0]?.n).toBe("1");
  });
});

describe("captureSale auth (Option Y) — refusals collapse to 401", () => {
  it("missing Authorization → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idemKey())
      .send(captureBody());
    expect(res.status).toBe(401);
  });

  it("missing body attestation → 401", async () => {
    if (maybeSkip()) return;
    const body = captureBody();
    delete body.deviceTokenAttestation;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-mgr")
      .set("Idempotency-Key", idemKey())
      .send(body);
    expect(res.status).toBe(401);
  });

  it("unmapped Clerk subject → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-unmapped")
      .set("Idempotency-Key", idemKey())
      .send(captureBody());
    expect(res.status).toBe(401);
  });

  it("soft-deleted user → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-deleted")
      .set("Idempotency-Key", idemKey())
      .send(captureBody());
    expect(res.status).toBe(401);
  });

  it("revoked device attestation → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-mgr")
      .set("Idempotency-Key", idemKey())
      .send(captureBody({ deviceTokenAttestation: DEVICE_REVOKED_ATTESTATION }));
    expect(res.status).toBe(401);
  });

  it("ineligible role (store_staff) → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-staff")
      .set("Idempotency-Key", idemKey())
      .send(captureBody());
    expect(res.status).toBe(401);
  });

  it("specific store access without grant for the device store → 401", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post("/api/pos/v1/sales")
      .set("Authorization", "Bearer jwt-specific")
      .set("Idempotency-Key", idemKey())
      .send(captureBody());
    expect(res.status).toBe(401);
  });
});
