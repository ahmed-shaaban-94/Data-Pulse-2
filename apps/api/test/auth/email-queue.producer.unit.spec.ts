/**
 * email-queue.producer.unit.spec.ts
 *
 * Docker-free unit coverage for EmailQueueProducer.
 *
 * Strategy: jest.fn()-based mocks for the QueueLike interface.
 * No real BullMQ runtime, no Redis, no Testcontainers.
 *
 * The integration spec (email-queue.producer.spec.ts) covers the full
 * producer surface with a hand-written FakeQueue class. This spec
 * uses jest.fn() mocks and targets:
 *   - enqueuePasswordReset: correct job name, payload, and jobId
 *   - enqueueEmailVerification: correct job name, payload, and jobId
 *   - enqueueInvitation: correct job name (memberships.invitation), payload, and jobId
 *   - queue.add() throws → error propagates to caller for all three methods
 *   - deriveJobId: deterministic hash, scope prefix isolation
 *   - jobId format: `<scope>:<32-hex-chars>` — no PII
 */

import {
  deriveJobId,
  EMAIL_JOB_NAMES,
  EmailQueueProducer,
  type QueueLike,
} from "../../src/auth/email-queue.producer";
import type {
  PasswordResetEmailJob,
  EmailVerificationEmailJob,
  InvitationEmailJob,
} from "../../src/auth/email-job.enqueuer";

// ---------------------------------------------------------------------------
// Fixed test data
// ---------------------------------------------------------------------------

const RAW_TOKEN = "raw-token-cccccccccccccccccc";
const USER_ID   = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const EMAIL     = "carol@example.com";

const PW_RESET_JOB: PasswordResetEmailJob = {
  email: EMAIL,
  rawToken: RAW_TOKEN,
  userId: USER_ID,
};

const EMAIL_VERIFY_JOB: EmailVerificationEmailJob = {
  email: EMAIL,
  rawToken: RAW_TOKEN,
  userId: USER_ID,
};

const INVITATION_JOB: InvitationEmailJob = {
  email: EMAIL,
  rawToken: RAW_TOKEN,
  tenantId: TENANT_ID,
};

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockQueue(rejectWith?: Error): jest.Mocked<QueueLike> {
  const addFn = jest.fn<Promise<unknown>, [string, unknown, ({ jobId?: string } | undefined)?]>();
  if (rejectWith) {
    addFn.mockRejectedValue(rejectWith);
  } else {
    addFn.mockResolvedValue({ id: "mock-job-id" });
  }
  return { add: addFn };
}

// ===========================================================================
// enqueuePasswordReset
// ===========================================================================

describe("EmailQueueProducer.enqueuePasswordReset", () => {
  it("EQP-U1: calls queue.add with job name 'auth.password-reset'", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueuePasswordReset(PW_RESET_JOB);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]![0]).toBe(EMAIL_JOB_NAMES.passwordReset);
    expect(queue.add.mock.calls[0]![0]).toBe("auth.password-reset");
  });

  it("EQP-U2: passes the payload fields in the second argument", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueuePasswordReset(PW_RESET_JOB);

    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining(PW_RESET_JOB),
    );
  });

  it("EQP-U3: derives jobId deterministically from rawToken with 'pwreset' scope", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueuePasswordReset(PW_RESET_JOB);

    const opts = queue.add.mock.calls[0]![2];
    expect(opts?.jobId).toBe(deriveJobId("pwreset", RAW_TOKEN));
    expect(opts?.jobId).toMatch(/^pwreset:[0-9a-f]{32}$/);
  });

  it("EQP-U4: propagates errors thrown by queue.add", async () => {
    const err = new Error("queue connection refused");
    const queue = makeMockQueue(err);
    const producer = new EmailQueueProducer(queue);

    await expect(producer.enqueuePasswordReset(PW_RESET_JOB)).rejects.toThrow(
      "queue connection refused",
    );
  });
});

// ===========================================================================
// enqueueEmailVerification
// ===========================================================================

describe("EmailQueueProducer.enqueueEmailVerification", () => {
  it("EQP-U5: calls queue.add with job name 'auth.email-verify'", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueueEmailVerification(EMAIL_VERIFY_JOB);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]![0]).toBe(EMAIL_JOB_NAMES.emailVerification);
    expect(queue.add.mock.calls[0]![0]).toBe("auth.email-verify");
  });

  it("EQP-U6: passes the payload fields in the second argument", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueueEmailVerification(EMAIL_VERIFY_JOB);

    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining(EMAIL_VERIFY_JOB),
    );
  });

  it("EQP-U7: derives jobId deterministically from rawToken with 'verify' scope", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueueEmailVerification(EMAIL_VERIFY_JOB);

    const opts = queue.add.mock.calls[0]![2];
    expect(opts?.jobId).toBe(deriveJobId("verify", RAW_TOKEN));
    expect(opts?.jobId).toMatch(/^verify:[0-9a-f]{32}$/);
  });

  it("EQP-U8: propagates errors thrown by queue.add", async () => {
    const err = new Error("bullmq write error");
    const queue = makeMockQueue(err);
    const producer = new EmailQueueProducer(queue);

    await expect(producer.enqueueEmailVerification(EMAIL_VERIFY_JOB)).rejects.toThrow(
      "bullmq write error",
    );
  });
});

// ===========================================================================
// enqueueInvitation
// ===========================================================================

describe("EmailQueueProducer.enqueueInvitation", () => {
  it("EQP-U9: calls queue.add with job name 'memberships.invitation'", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueueInvitation(INVITATION_JOB);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]![0]).toBe(EMAIL_JOB_NAMES.invitation);
    expect(queue.add.mock.calls[0]![0]).toBe("memberships.invitation");
  });

  it("EQP-U10: passes the invitation payload fields in the second argument", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueueInvitation(INVITATION_JOB);

    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining(INVITATION_JOB),
    );
  });

  it("EQP-U11: derives jobId deterministically from rawToken with 'invite' scope", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueueInvitation(INVITATION_JOB);

    const opts = queue.add.mock.calls[0]![2];
    expect(opts?.jobId).toBe(deriveJobId("invite", RAW_TOKEN));
    expect(opts?.jobId).toMatch(/^invite:[0-9a-f]{32}$/);
  });

  it("EQP-U12: propagates errors thrown by queue.add", async () => {
    const err = new Error("redis ETIMEDOUT");
    const queue = makeMockQueue(err);
    const producer = new EmailQueueProducer(queue);

    await expect(producer.enqueueInvitation(INVITATION_JOB)).rejects.toThrow("redis ETIMEDOUT");
  });
});

// ===========================================================================
// Cross-method scope isolation
// ===========================================================================

describe("EmailQueueProducer — scope isolation across methods", () => {
  it("EQP-U13: password-reset and email-verify produce different jobIds for same rawToken", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueuePasswordReset(PW_RESET_JOB);
    await producer.enqueueEmailVerification(EMAIL_VERIFY_JOB);

    const jobId0 = queue.add.mock.calls[0]![2]?.jobId;
    const jobId1 = queue.add.mock.calls[1]![2]?.jobId;
    expect(jobId0).not.toBe(jobId1);
    expect(jobId0).toMatch(/^pwreset:/);
    expect(jobId1).toMatch(/^verify:/);
  });

  it("EQP-U14: invitation produces a jobId isolated from password-reset scope", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);

    await producer.enqueuePasswordReset(PW_RESET_JOB);
    await producer.enqueueInvitation(INVITATION_JOB);

    const jobId0 = queue.add.mock.calls[0]![2]?.jobId;
    const jobId1 = queue.add.mock.calls[1]![2]?.jobId;
    expect(jobId0).toMatch(/^pwreset:/);
    expect(jobId1).toMatch(/^invite:/);
    expect(jobId0).not.toBe(jobId1);
  });
});

// ===========================================================================
// EMAIL_JOB_NAMES constants
// ===========================================================================

describe("EMAIL_JOB_NAMES constants", () => {
  it("EQP-U15: passwordReset is 'auth.password-reset'", () => {
    expect(EMAIL_JOB_NAMES.passwordReset).toBe("auth.password-reset");
  });

  it("EQP-U16: emailVerification is 'auth.email-verify'", () => {
    expect(EMAIL_JOB_NAMES.emailVerification).toBe("auth.email-verify");
  });

  it("EQP-U17: invitation is 'memberships.invitation'", () => {
    expect(EMAIL_JOB_NAMES.invitation).toBe("memberships.invitation");
  });
});

// ===========================================================================
// deriveJobId — unit assertions
// ===========================================================================

describe("deriveJobId — unit assertions", () => {
  it("EQP-U18: produces same output for same inputs (pure/deterministic)", () => {
    const a = deriveJobId("pwreset", RAW_TOKEN);
    const b = deriveJobId("pwreset", RAW_TOKEN);
    expect(a).toBe(b);
  });

  it("EQP-U19: format is `<scope>:<32-hex-chars>` — exactly 32 lowercase hex after colon", () => {
    const id = deriveJobId("verify", RAW_TOKEN);
    const [scope, hash] = id.split(":");
    expect(scope).toBe("verify");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("EQP-U20: jobId does NOT contain email, userId, or raw token (no PII)", async () => {
    const queue = makeMockQueue();
    const producer = new EmailQueueProducer(queue);
    await producer.enqueuePasswordReset(PW_RESET_JOB);

    const jobId = queue.add.mock.calls[0]![2]?.jobId ?? "";
    expect(jobId).not.toContain(EMAIL);
    expect(jobId).not.toContain(USER_ID);
    expect(jobId).not.toContain(RAW_TOKEN);
  });
});
