/**
 * T114 — EmailProcessor spec.
 *
 * Pure unit-level. The processor's collaborators are:
 *   - an `EmailAdapter` (driven port — represented in tests by
 *     `RecordingEmailAdapter`, which captures every send), and
 *   - templated render functions (pure, no I/O).
 *
 * No real BullMQ runtime, no Redis, no `ioredis-mock`, no provider SDK.
 * The processor is invoked directly with `(jobName, data)` exactly as a
 * future BullMQ `Worker` callback would invoke it.
 *
 * Coverage matches T114 + the approval list:
 *   - dispatches `auth.password-reset` to the password-reset template
 *   - dispatches `auth.email-verify` to the verification template
 *   - unknown job name throws (so future BullMQ DLQ fires)
 *   - malformed payload throws BEFORE adapter.send
 *   - adapter failure propagates (so future BullMQ retries fire)
 *   - rawToken is present in the rendered body (email is functional)
 *   - userId is NOT present in subject, tags, or body
 *   - tags are PII-free
 *   - to === payload.email
 *   - subject is non-empty
 */
import {
  EmailProcessor,
  EMAIL_JOB_NAMES,
  UnknownEmailJobError,
  MalformedEmailJobError,
} from "../../src/email/email.processor";
import {
  RecordingEmailAdapter,
  type EmailMessage,
} from "../../src/email/email.adapter";

const RAW_TOKEN = "raw-token-aaaaaaaaaaaaaaaaaa";
const EMAIL = "alice@example.com";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";

let adapter: RecordingEmailAdapter;
let processor: EmailProcessor;

beforeEach(() => {
  adapter = new RecordingEmailAdapter();
  processor = new EmailProcessor(adapter);
});

describe("EmailProcessor — auth.password-reset", () => {
  it("dispatches the password-reset job to adapter.send exactly once", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent).toHaveLength(1);
  });

  it("sends to the address from the job payload", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("renders a non-empty subject", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const { subject } = adapter.sent[0]!;
    expect(subject).toBeDefined();
    expect(subject.length).toBeGreaterThan(0);
  });

  it("includes the rawToken in the rendered body so the email is functional", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(RAW_TOKEN);
    if (message.htmlBody) {
      expect(message.htmlBody).toContain(RAW_TOKEN);
    }
  });
});

describe("EmailProcessor — auth.email-verify", () => {
  it("dispatches the verification job to adapter.send exactly once", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent).toHaveLength(1);
  });

  it("sends to the address from the job payload", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("renders a non-empty subject", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent[0]!.subject.length).toBeGreaterThan(0);
  });

  it("includes the rawToken in the rendered body so the email is functional", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(RAW_TOKEN);
    if (message.htmlBody) {
      expect(message.htmlBody).toContain(RAW_TOKEN);
    }
  });

  it("renders a different subject than the password-reset job", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const verifySubject = adapter.sent[0]!.subject;

    adapter = new RecordingEmailAdapter();
    processor = new EmailProcessor(adapter);
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const resetSubject = adapter.sent[0]!.subject;

    expect(verifySubject).not.toBe(resetSubject);
  });
});

describe("EmailProcessor — error paths", () => {
  it("throws UnknownEmailJobError on an unknown job name (so BullMQ DLQ fires)", async () => {
    await expect(
      processor.process("auth.not-a-real-job", {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(UnknownEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError BEFORE calling adapter.send when payload is missing fields", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        // rawToken missing
        userId: USER_ID,
      } as unknown),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError when email is not a valid email", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: "not-an-email",
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError when rawToken is empty", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: "",
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError when payload is null", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, null),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("propagates errors thrown by adapter.send (so BullMQ can retry)", async () => {
    adapter.reject = new Error("smtp ECONNREFUSED");
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toThrow("smtp ECONNREFUSED");
  });
});

describe("EmailProcessor — PII discipline", () => {
  const everyJob: ReadonlyArray<readonly [string, string]> = [
    ["password reset", EMAIL_JOB_NAMES.passwordReset],
    ["email verify", EMAIL_JOB_NAMES.emailVerification],
  ];

  it.each(everyJob)(
    "%s: userId never appears in subject, body, or tags",
    async (_label, jobName) => {
      await processor.process(jobName, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      });
      const message: EmailMessage = adapter.sent[0]!;
      expect(message.subject).not.toContain(USER_ID);
      expect(message.textBody).not.toContain(USER_ID);
      if (message.htmlBody) {
        expect(message.htmlBody).not.toContain(USER_ID);
      }
      const tagsBlob = JSON.stringify(message.tags ?? {});
      expect(tagsBlob).not.toContain(USER_ID);
      expect(tagsBlob).not.toContain(EMAIL);
      expect(tagsBlob).not.toContain(RAW_TOKEN);
    },
  );

  it.each(everyJob)(
    "%s: tags (if present) only contain non-PII labels",
    async (_label, jobName) => {
      await processor.process(jobName, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      });
      const tags = adapter.sent[0]!.tags;
      if (tags) {
        for (const value of Object.values(tags)) {
          expect(value).not.toContain("@");
          expect(value).not.toContain(USER_ID);
          expect(value).not.toContain(RAW_TOKEN);
        }
      }
    },
  );
});

describe("EmailProcessor — job name contract with EmailQueueProducer", () => {
  // The producer in `apps/api/src/auth/email-queue.producer.ts` writes
  // these exact string literals. If either side drifts, this test fails
  // and reminds us to extract the constants to `packages/shared`.
  it("uses 'auth.password-reset' for password reset jobs", () => {
    expect(EMAIL_JOB_NAMES.passwordReset).toBe("auth.password-reset");
  });
  it("uses 'auth.email-verify' for email verification jobs", () => {
    expect(EMAIL_JOB_NAMES.emailVerification).toBe("auth.email-verify");
  });
});
