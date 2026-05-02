/**
 * AuthService — sign-in only (slice 3a).
 *
 * Refresh, sign-out, password reset, and email verification land in slice
 * 3c (controller + remaining service methods). Rate limiting / account
 * lockout lands in slice 3b — this service accepts a `RateLimiter`
 * interface for the eventual integration but defaults to a no-op so 3a
 * is testable in isolation.
 *
 * FR-ISO-4 / credential-stuffing safety: every failure path throws the
 * SAME `UnauthorizedException`. The exception filter renders it as a 401
 * envelope. We never leak whether an email exists, whether the password
 * was wrong, or whether the user is SSO-only / soft-deleted.
 */
import {
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import { verifyPassword } from "@data-pulse-2/auth";
import { users } from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";
import type { SignInInput, SignInResult } from "./dto";
import { SessionRepository } from "./session.repository";

/**
 * Pre-computed argon2id PHC string used for the constant-time path when
 * the email isn't found. The actual password value is irrelevant — we
 * only need a real PHC string so `verifyPassword` runs the full work,
 * keeping per-request latency consistent regardless of whether the user
 * exists. The string was generated once with the OWASP 2025 params.
 */
const DUMMY_PHC =
  "$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU";

const ABSOLUTE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h, per data-model §9.

/**
 * Future hook for slice 3b's per-account / per-IP rate limit. The
 * interface is exposed here so dependents can be wired now; the no-op
 * default keeps this slice self-contained.
 */
export interface RateLimiter {
  checkAndConsume(key: string): Promise<{ allowed: boolean }>;
}

class NoOpRateLimiter implements RateLimiter {
  async checkAndConsume(_key: string): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }
}

export interface AuthServiceOptions {
  rateLimiter?: RateLimiter;
}

@Injectable()
export class AuthService {
  private readonly db: NodePgDatabase;
  private readonly rateLimiter: RateLimiter;

  constructor(
    private readonly pool: Pool,
    private readonly sessions: SessionRepository,
    opts: AuthServiceOptions = {},
  ) {
    this.db = drizzle(pool);
    this.rateLimiter = opts.rateLimiter ?? new NoOpRateLimiter();
  }

  /**
   * Verify credentials and create a dashboard session. Returns the cookie
   * value (`sessionId`) plus metadata; the controller (slice 3c)
   * serializes it with the appropriate `HttpOnly; Secure; SameSite=Lax`
   * attributes.
   *
   * Throws a uniform UnauthorizedException for ALL failure modes.
   */
  async signIn(input: SignInInput): Promise<SignInResult> {
    // Slice 3b will check the rate limiter here. The no-op always allows.
    void this.rateLimiter;

    const { email, password } = input;
    const userRow = await this.findActiveUserByEmail(email);

    // Always run the verify call — even when the user is missing, using
    // a dummy PHC — so request latency doesn't depend on existence.
    const phc = userRow?.passwordHash ?? DUMMY_PHC;
    const passwordOk = await verifyPassword(phc, password);

    // Refuse if any of: user missing, soft-deleted, no password (SSO-only),
    // or wrong password. All paths produce the same exception.
    if (!userRow || userRow.passwordHash === null || !passwordOk) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const sessionId = newId();
    const absoluteExpiresAt = new Date(Date.now() + ABSOLUTE_EXPIRY_MS);
    await this.sessions.create({
      id: sessionId,
      userId: userRow.id,
      absoluteExpiresAt,
    });

    return {
      sessionId,
      userId: userRow.id,
      absoluteExpiresAt,
    };
  }

  private async findActiveUserByEmail(email: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }
}
