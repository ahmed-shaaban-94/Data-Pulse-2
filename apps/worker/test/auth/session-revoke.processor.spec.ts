/**
 * T302 — SessionRevokeProcessor spec.
 *
 * Pure unit-level: no Redis, no Postgres, no Testcontainers, no BullMQ runtime.
 * The processor is instantiated directly with a Jest-spy SessionDbLike seam —
 * the same pattern used by AuditFanoutProcessor + EmailProcessor.
 *
 * Coverage:
 *   - happy path: revokeSession called once with session_id from payload
 *   - idempotent already-revoked: false return → processor does NOT throw
 *   - idempotent missing session: false return → processor does NOT throw
 *   - malformed payload (missing session_id) → MalformedSessionRevokeJobError, 0 db calls
 *   - malformed payload (non-UUID session_id) → MalformedSessionRevokeJobError, 0 db calls
 *   - malformed payload (null) → MalformedSessionRevokeJobError, 0 db calls
 *   - malformed payload (non-object) → MalformedSessionRevokeJobError, 0 db calls
 *   - unknown job name → UnknownSessionRevokeJobError
 *   - transient DB error propagates unwrapped (BullMQ retry)
 *   - SESSION_REVOKE_JOB_NAME literal pin
 */
import {
  SessionRevokeProcessor,
  SESSION_REVOKE_JOB_NAME,
  MalformedSessionRevokeJobError,
  UnknownSessionRevokeJobError,
  type SessionDbLike,
} from "../../src/auth/session-revoke.processor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "018e4a1b-0000-7000-8000-000000000001";

const VALID_PAYLOAD = {
  session_id: SESSION_ID,
};

// ---------------------------------------------------------------------------
// Spy factory
// ---------------------------------------------------------------------------

function buildSpyDb(defaultReturn = true): SessionDbLike & {
  revokeSession: jest.MockedFunction<SessionDbLike["revokeSession"]>;
} {
  const revokeSession = jest.fn(async (_id: string) => defaultReturn);
  return { revokeSession };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionRevokeProcessor", () => {
  let db: ReturnType<typeof buildSpyDb>;
  let processor: SessionRevokeProcessor;

  beforeEach(() => {
    db = buildSpyDb();
    processor = new SessionRevokeProcessor(db);
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it("calls revokeSession once with the session_id from the payload", async () => {
    await processor.process(SESSION_REVOKE_JOB_NAME, VALID_PAYLOAD);
    expect(db.revokeSession).toHaveBeenCalledTimes(1);
    expect(db.revokeSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("resolves without throwing when revokeSession returns true", async () => {
    db.revokeSession.mockResolvedValueOnce(true);
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, VALID_PAYLOAD),
    ).resolves.toBeUndefined();
  });

  // ── Idempotency (FR-AUTH-6) ────────────────────────────────────────────

  it("does NOT throw when revokeSession returns false (already-revoked)", async () => {
    db.revokeSession.mockResolvedValueOnce(false);
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, VALID_PAYLOAD),
    ).resolves.toBeUndefined();
  });

  it("does NOT throw when revokeSession returns false (missing session)", async () => {
    db = buildSpyDb(false);
    processor = new SessionRevokeProcessor(db);
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, VALID_PAYLOAD),
    ).resolves.toBeUndefined();
  });

  // ── Malformed payload ───────────────────────────────────────────────────

  it("throws MalformedSessionRevokeJobError when session_id is missing", async () => {
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, {}),
    ).rejects.toBeInstanceOf(MalformedSessionRevokeJobError);
  });

  it("throws MalformedSessionRevokeJobError when session_id is not a UUID", async () => {
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, { session_id: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(MalformedSessionRevokeJobError);
  });

  it("throws MalformedSessionRevokeJobError when session_id is a number", async () => {
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, { session_id: 12345 }),
    ).rejects.toBeInstanceOf(MalformedSessionRevokeJobError);
  });

  it("throws MalformedSessionRevokeJobError when payload is null", async () => {
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, null),
    ).rejects.toBeInstanceOf(MalformedSessionRevokeJobError);
  });

  it("throws MalformedSessionRevokeJobError when payload is a string", async () => {
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, "not-an-object"),
    ).rejects.toBeInstanceOf(MalformedSessionRevokeJobError);
  });

  it("does not call revokeSession on a malformed payload", async () => {
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, { session_id: "bad" }),
    ).rejects.toThrow();
    expect(db.revokeSession).not.toHaveBeenCalled();
  });

  // ── Unknown job name ────────────────────────────────────────────────────

  it("throws UnknownSessionRevokeJobError for an unrecognised job name", async () => {
    await expect(
      processor.process("auth.unknown-job", VALID_PAYLOAD),
    ).rejects.toBeInstanceOf(UnknownSessionRevokeJobError);
  });

  it("does not call revokeSession on an unknown job name", async () => {
    await expect(
      processor.process("auth.unknown-job", VALID_PAYLOAD),
    ).rejects.toThrow();
    expect(db.revokeSession).not.toHaveBeenCalled();
  });

  // ── Transient DB error propagation ─────────────────────────────────────

  it("propagates a transient DB error unwrapped so BullMQ can retry", async () => {
    const dbError = new Error("pg: connection refused");
    db.revokeSession.mockRejectedValueOnce(dbError);
    await expect(
      processor.process(SESSION_REVOKE_JOB_NAME, VALID_PAYLOAD),
    ).rejects.toBe(dbError);
  });

  // ── Job name pin ───────────────────────────────────────────────────────

  it("SESSION_REVOKE_JOB_NAME is exactly 'session-revoke'", () => {
    expect(SESSION_REVOKE_JOB_NAME).toBe("session-revoke");
  });
});
