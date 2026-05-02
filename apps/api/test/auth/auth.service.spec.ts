/**
 * T108 — AuthService spec (sign-in subset).
 *
 * Real Postgres via Testcontainers. The argon2id verify is real — no
 * mocking — so this also doubles as an integration test of the
 * `@data-pulse-2/auth` password helper.
 *
 * Verifies:
 *   - successful sign-in returns a session id and creates a session row
 *   - wrong password throws UnauthorizedException
 *   - unknown email throws UnauthorizedException
 *   - SSO-only user (NULL password_hash) throws UnauthorizedException
 *   - soft-deleted user throws UnauthorizedException
 *   - the same exception shape comes out of all four failure paths
 *     (FR-ISO-4 / no email-existence leak)
 */
import { hashPassword } from "@data-pulse-2/auth";
import { newId } from "@data-pulse-2/shared";
import { UnauthorizedException } from "@nestjs/common";
import { Pool } from "pg";
import { AuthService } from "../../src/auth/auth.service";
import { SessionRepository } from "../../src/auth/session.repository";
import {
  applyUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let service: AuthService;
let sessions: SessionRepository;

const ALICE_ID = "0a000000-0000-7000-8000-00000000aa01";
const ALICE_EMAIL = "alice@example.com";
const ALICE_PASSWORD = "correct horse battery staple";

const SSO_ID = "0a000000-0000-7000-8000-00000000aa02";
const SSO_EMAIL = "sso-only@example.com";

const DELETED_ID = "0a000000-0000-7000-8000-00000000aa03";
const DELETED_EMAIL = "deleted@example.com";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });

    const aliceHash = await hashPassword(ALICE_PASSWORD);
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [ALICE_ID, ALICE_EMAIL, aliceHash],
    );
    // SSO-only: password_hash is NULL.
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, NULL)`,
      [SSO_ID, SSO_EMAIL],
    );
    // Soft-deleted user.
    const deletedHash = await hashPassword("any-password");
    await pool.query(
      `INSERT INTO users (id, email, password_hash, deleted_at)
       VALUES ($1, $2, $3, now())`,
      [DELETED_ID, DELETED_EMAIL, deletedHash],
    );

    sessions = new SessionRepository(pool);
    service = new AuthService(pool, sessions);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[auth.service.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe("AuthService.signIn — happy path", () => {
  it("authenticates with the correct password and creates a session", async () => {
    const result = await service.signIn({
      email: ALICE_EMAIL,
      password: ALICE_PASSWORD,
    });
    expect(result.userId).toBe(ALICE_ID);
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    // ~24h ahead.
    const ttlMs = result.absoluteExpiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(25 * 60 * 60 * 1000);

    // The session row exists in Postgres.
    const found = await sessions.findActiveById(result.sessionId);
    expect(found?.userId).toBe(ALICE_ID);
  });
});

describe("AuthService.signIn — failure modes share a uniform exception", () => {
  const expectInvalidCredentials = (label: string, fn: () => Promise<unknown>) => {
    it(`throws UnauthorizedException for ${label}`, async () => {
      await expect(fn()).rejects.toBeInstanceOf(UnauthorizedException);
      try {
        await fn();
      } catch (err) {
        const e = err as UnauthorizedException;
        expect(e.getStatus()).toBe(401);
        const response = e.getResponse() as { message?: string };
        expect(response.message).toBe("Invalid credentials");
      }
    });
  };

  expectInvalidCredentials("wrong password", () =>
    service.signIn({ email: ALICE_EMAIL, password: "definitely-not-it" }),
  );

  expectInvalidCredentials("unknown email", () =>
    service.signIn({
      email: "nobody-here@example.com",
      password: "anything",
    }),
  );

  expectInvalidCredentials("SSO-only user (NULL password_hash)", () =>
    service.signIn({ email: SSO_EMAIL, password: "anything" }),
  );

  expectInvalidCredentials("soft-deleted user", () =>
    service.signIn({ email: DELETED_EMAIL, password: "any-password" }),
  );

  it("does not create a session row on any failure", async () => {
    const before = await pool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions",
    );

    // Run all four failure paths.
    await Promise.allSettled([
      service.signIn({ email: ALICE_EMAIL, password: "wrong" }),
      service.signIn({ email: "nobody@example.com", password: "x" }),
      service.signIn({ email: SSO_EMAIL, password: "x" }),
      service.signIn({ email: DELETED_EMAIL, password: "x" }),
    ]);

    const after = await pool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions",
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });
});

describe("AuthService.signIn — input shape", () => {
  it("normalises email casing via the Zod-side transform (citext+normalisation)", async () => {
    // Email schema in dto.ts trims + lowercases. AuthService receives the
    // already-parsed input; here we pass an already-normalised value but
    // confirm citext semantics by issuing a different-cased query.
    const result = await service.signIn({
      email: ALICE_EMAIL.toUpperCase().trim(),
      password: ALICE_PASSWORD,
    });
    // Citext means "ALICE@EXAMPLE.COM" matches the row even though the
    // stored value is lowercase.
    expect(result.userId).toBe(ALICE_ID);
  });
});
