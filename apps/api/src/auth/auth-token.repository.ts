/**
 * AuthTokenRepository — Postgres source of truth for opaque bearer tokens.
 *
 * `auth_tokens` is tenant-scoped (RLS-enabled, `tenant_id` nullable for
 * platform tokens). Callers who need RLS-aware lookups (i.e., from request
 * context) should pass a `PoolClient` obtained via `runWithTenantContext`;
 * callers who legitimately need platform scope (issuing or admin paths)
 * use the admin pool directly.
 *
 * The repository hashes the raw token internally so callers never pass a
 * raw secret as a SQL parameter.
 */
import { Injectable } from "@nestjs/common";
import {
  type AuthTokenRow,
  authTokens,
  type NewAuthTokenRow,
} from "@data-pulse-2/db/schema";
import { hashToken } from "@data-pulse-2/auth";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";

type DrizzleClient = NodePgDatabase;

function db(client: Pool | PoolClient): DrizzleClient {
  return drizzle(client as Pool);
}

@Injectable()
export class AuthTokenRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Issue a new auth token. The caller supplies the raw token (use
   * `generateRawToken()` from `@data-pulse-2/auth`) and the row metadata;
   * we hash it here and write the hash to `token_hash`.
   *
   * Issuance bypasses RLS — it runs on the admin pool by default. Pass
   * `client` when you want issuance to happen inside an existing tenant
   * context (uncommon but possible).
   */
  async issue(
    rawToken: string,
    input: Omit<NewAuthTokenRow, "tokenHash">,
    client?: PoolClient,
  ): Promise<AuthTokenRow> {
    const target = client ?? this.pool;
    const tokenHash = hashToken(rawToken);
    const [row] = await db(target)
      .insert(authTokens)
      .values({ ...input, tokenHash })
      .returning();
    if (!row) {
      throw new Error("AuthTokenRepository.issue: insert returned no row");
    }
    return row;
  }

  /**
   * Look up an active token by its raw form. Returns null when the hash
   * isn't found, the row is revoked, or the row is past `expires_at`.
   *
   * Pass a `client` from `runWithTenantContext` to apply tenant RLS;
   * otherwise queries against the admin pool see all rows (only
   * appropriate for platform-admin paths).
   */
  async findActiveByRawToken(
    rawToken: string,
    client?: PoolClient,
  ): Promise<AuthTokenRow | null> {
    const target = client ?? this.pool;
    const tokenHash = hashToken(rawToken);
    const rows = await db(target)
      .select()
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          isNull(authTokens.revokedAt),
          gt(authTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Revoke a token by id. Idempotent: returns true on first revoke and
   * false on subsequent calls (the row's `revoked_at` is already set).
   */
  async revoke(id: string, client?: PoolClient): Promise<boolean> {
    const target = client ?? this.pool;
    const result = await db(target)
      .update(authTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(authTokens.id, id), isNull(authTokens.revokedAt)));
    return (result.rowCount ?? 0) > 0;
  }
}
