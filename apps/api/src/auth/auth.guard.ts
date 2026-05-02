/**
 * AuthGuard — slice 3b.
 *
 * Authenticates a request via either:
 *   1. The dashboard cookie `dp2_session` (preferred when present), or
 *   2. The `Authorization: Bearer <raw-token>` header.
 *
 * Cookie wins when both are present: dashboard humans go through the
 * cookie path, and a stale `Authorization` header (e.g. copy-pasted from
 * a curl session) must not override the active dashboard session.
 *
 * Every failure mode — missing credential, malformed header, expired,
 * revoked, unknown — produces the SAME `UnauthorizedException`. The
 * global exception filter renders that as the canonical 401 envelope.
 * This uniformity is required by FR-ISO-4 (no email/session-existence
 * leak via differing error shapes).
 *
 * On success the guard attaches a `principal` object to the request so
 * downstream interceptors / controllers (slice 3c+) can read who the
 * caller is without re-doing the lookup.
 *
 * Wiring: this guard is intentionally NOT registered globally and NOT
 * attached to any controller in this slice. The auth controller (slice
 * 3c) will `@UseGuards(AuthGuard)` once it lands.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";
import { SessionRepository } from "./session.repository";
import { AuthTokenRepository } from "./auth-token.repository";

export const SESSION_COOKIE_NAME = "dp2_session";
const BEARER_PREFIX = "bearer ";

/**
 * The authenticated caller, attached as `request.principal` on success.
 *
 * `kind: "session"` is a dashboard human authenticated via cookie; the
 * sessionId IS the cookie value.
 *
 * `kind: "token"` is an API/POS caller authenticated via opaque bearer
 * token. `tenantId` is null for platform-admin tokens.
 */
export type Principal =
  | {
      kind: "session";
      sessionId: string;
      userId: string;
    }
  | {
      kind: "token";
      tokenId: string;
      tenantId: string | null;
      userId: string | null;
    };

/**
 * Express request shape with the per-request fields populated by upstream
 * interceptors (`request-id.interceptor.ts`) plus the new `principal`
 * field this guard attaches.
 */
export type AuthedRequest = Request & {
  cookies?: Record<string, string | undefined>;
  requestId?: string;
  principal?: Principal;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly authTokens: AuthTokenRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();

    const sessionId = readSessionCookie(request);
    if (sessionId !== null) {
      const session = await this.sessions.findActiveById(sessionId);
      if (!session) throw unauthorized();
      request.principal = principalFromSession(session);
      return true;
    }

    const rawToken = readBearerToken(request);
    if (rawToken !== null) {
      const token = await this.authTokens.findActiveByRawToken(rawToken);
      if (!token) throw unauthorized();
      request.principal = principalFromToken(token);
      return true;
    }

    throw unauthorized();
  }
}

function readSessionCookie(request: AuthedRequest): string | null {
  const value = request.cookies?.[SESSION_COOKIE_NAME];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBearerToken(request: AuthedRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return null;
  if (header.length < BEARER_PREFIX.length) return null;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return null;
  }
  const raw = header.slice(BEARER_PREFIX.length).trim();
  return raw.length > 0 ? raw : null;
}

function principalFromSession(session: SessionRow): Principal {
  return {
    kind: "session",
    sessionId: session.id,
    userId: session.userId,
  };
}

function principalFromToken(token: AuthTokenRow): Principal {
  return {
    kind: "token",
    tokenId: token.id,
    tenantId: token.tenantId,
    userId: token.userId,
  };
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}
