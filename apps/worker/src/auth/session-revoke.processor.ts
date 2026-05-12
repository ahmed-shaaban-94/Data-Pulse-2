/**
 * SessionRevokeProcessor — T302.
 *
 * Worker-side processor that consumes `session-revoke` BullMQ jobs and calls
 * `db.revokeSession(sessionId)` via the injected `SessionDbLike` seam.
 *
 * Layered architecture (mirrors AuditFanoutProcessor)
 * -------------------------------------------------------
 *   Layer A (this file): pure `(jobName, data) → dbLike.revokeSession(id)`.
 *     Knows nothing about BullMQ runtime, Redis, retry, or DB connection.
 *   Layer B (follow-on slice): BullMQ Worker bootstrap, Redis connection,
 *     retry/backoff/DLQ, `worker.module.ts` registration, and API-side wiring.
 *
 * Error contract
 * --------------
 *   - `MalformedSessionRevokeJobError` — payload doesn't match the schema.
 *     Thrown before any db call; BullMQ should route to DLQ (T301 follow-on).
 *   - `UnknownSessionRevokeJobError` — unrecognised job name.
 *   - Any other error from `dbLike.revokeSession` propagates unwrapped so
 *     BullMQ can apply its retry/backoff policy.
 *
 * Idempotency (FR-AUTH-6)
 * -----------------------
 * `db.revokeSession` returns `false` when the session is already revoked or
 * not found. The processor treats `false` as success — the desired end-state
 * (session revoked) is already true, so retrying would be pointless. Throwing
 * here would cause BullMQ to retry, which is wrong for an idempotent operation.
 *
 * Cross-app isolation
 * -------------------
 * This file MUST NOT import from `apps/api` or `@data-pulse-2/db`.
 * `SessionDbLike` is a LOCAL minimal interface structurally equivalent to the
 * `revoke()` method on `apps/api/src/auth/session.repository.ts`.
 */
import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Job name
// ---------------------------------------------------------------------------

/**
 * BullMQ job name this processor handles. Pinned by a unit test so any
 * producer/consumer drift fails CI loudly.
 */
export const SESSION_REVOKE_JOB_NAME = "session-revoke";

// ---------------------------------------------------------------------------
// Worker-local job schema (no import from apps/api)
// ---------------------------------------------------------------------------

const SessionRevokeJobSchema = z.object({
  session_id: z.string().uuid(),
});

export type SessionRevokeJobData = z.infer<typeof SessionRevokeJobSchema>;

// ---------------------------------------------------------------------------
// DB seam (local — no import from @data-pulse-2/db)
// ---------------------------------------------------------------------------

/**
 * Minimal DB seam interface. Structurally mirrors `session.repository.ts#revoke`.
 * Satisfied in tests by a Jest spy; in production by a Drizzle-backed adapter.
 *
 * Returns `true` if the session was revoked, `false` if already-revoked or missing.
 */
export interface SessionDbLike {
  revokeSession(sessionId: string): Promise<boolean>;
}

/** DI token for the session DB seam. */
export const SESSION_DB = "SESSION_DB";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class MalformedSessionRevokeJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed session-revoke job '${jobName}': ${issue}`);
    this.name = "MalformedSessionRevokeJobError";
  }
}

export class UnknownSessionRevokeJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown session-revoke job name: '${jobName}'`);
    this.name = "UnknownSessionRevokeJobError";
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

@Injectable()
export class SessionRevokeProcessor {
  constructor(
    @Inject(SESSION_DB)
    private readonly db: SessionDbLike,
  ) {}

  async process(jobName: string, data: unknown): Promise<void> {
    if (jobName !== SESSION_REVOKE_JOB_NAME) {
      throw new UnknownSessionRevokeJobError(jobName);
    }

    const parsed = parseJobData(jobName, data);

    // revokeSession returns false when session is already revoked or not found.
    // Both cases represent the desired end-state — do not throw.
    await this.db.revokeSession(parsed.session_id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJobData(jobName: string, data: unknown): SessionRevokeJobData {
  const result = SessionRevokeJobSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const issue = first
      ? `${first.path.join(".") || "<root>"}: ${first.message}`
      : "validation failed";
    throw new MalformedSessionRevokeJobError(jobName, issue);
  }
  return result.data;
}
