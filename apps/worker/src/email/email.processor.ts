/**
 * EmailProcessor — slice 5 (T115).
 *
 * Pure logic. Given `(jobName, data)`, validates the payload, picks a
 * template, and hands the rendered message to the injected
 * `EmailAdapter`. Knows NOTHING about BullMQ runtime, Redis, retry, or
 * provider SDKs.
 *
 * Layered architecture
 * --------------------
 *   Layer A (this file): pure `(jobName, data) -> adapter.send(...)`.
 *   Layer B (deferred):  BullMQ `Worker` bootstrap, Redis connection,
 *                        retry/backoff/DLQ — Phase 2 task T090 and
 *                        Phase 10 task T301.
 *
 * A future `apps/worker/src/main.ts` will wire Layer B by instantiating
 * a BullMQ `Worker` over the `email` queue whose handler calls
 * `emailProcessor.process(job.name, job.data)`. That glue is
 * intentionally NOT in this slice.
 *
 * Job-name contract with `EmailQueueProducer`
 * -------------------------------------------
 * The producer in `apps/api/src/auth/email-queue.producer.ts` writes
 * these exact strings. We re-declare the constants here (rather than
 * cross-importing across apps) and a unit test pins the string
 * literals so any drift fails loudly. A later refactor can move the
 * shared constant to `packages/shared` once a second consumer needs it.
 *
 * Error contracts
 * ---------------
 *   - `MalformedEmailJobError` — payload doesn't match the schema.
 *     Throwing before `adapter.send` means BullMQ retries are wasted
 *     on a poison message; in practice these should land in the DLQ
 *     (T301 will configure that). This processor's job is just to
 *     refuse to act on malformed input.
 *   - `UnknownEmailJobError` — job name we don't recognise. Same DLQ
 *     fate.
 *   - Any other error from `adapter.send` propagates as-is so BullMQ
 *     can retry transport-level failures.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import {
  extractTraceContext,
  context,
  type TraceCarrier,
} from "@data-pulse-2/shared/observability/otel";
import {
  EMAIL_ADAPTER,
  type EmailAdapter,
} from "./email.adapter";
import {
  renderEmailVerificationEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
} from "./templates";

/**
 * BullMQ job names this processor handles. Mirrors `EMAIL_JOB_NAMES`
 * in `apps/api/src/auth/email-queue.producer.ts`. The values MUST
 * match the producer literally — see the unit test.
 */
export const EMAIL_JOB_NAMES = {
  passwordReset: "auth.password-reset",
  emailVerification: "auth.email-verify",
  invitation: "memberships.invitation",
} as const;

/**
 * Payload schema for auth jobs (password-reset, email-verify). The producer
 * guarantees this shape, but the processor revalidates at the boundary.
 */
const emailJobSchema = z.object({
  email: z.string().email().min(1),
  rawToken: z.string().min(1),
  userId: z.string().min(1),
});

export type EmailJobData = z.infer<typeof emailJobSchema>;

/**
 * Payload schema for invitation jobs. Differs from auth jobs: no userId
 * (invitees may not yet be users), has tenantId for audit.
 */
const invitationJobSchema = z.object({
  email: z.string().email().min(1),
  rawToken: z.string().min(1),
  tenantId: z.string().min(1),
});

export type InvitationJobData = z.infer<typeof invitationJobSchema>;

export class MalformedEmailJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed email job '${jobName}': ${issue}`);
    this.name = "MalformedEmailJobError";
  }
}

export class UnknownEmailJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown email job name: '${jobName}'`);
    this.name = "UnknownEmailJobError";
  }
}

@Injectable()
export class EmailProcessor {
  constructor(
    @Optional()
    @Inject(EMAIL_ADAPTER)
    private readonly adapter: EmailAdapter,
  ) {}

  async process(jobName: string, data: unknown): Promise<void> {
    const carrier =
      typeof data === "object" && data !== null && "traceContext" in data
        ? ((data as { traceContext?: TraceCarrier }).traceContext ?? {})
        : {};
    const restoredCtx = extractTraceContext(carrier);

    return context.with(restoredCtx, async () => {
      switch (jobName) {
        case EMAIL_JOB_NAMES.passwordReset: {
          const parsed = parseAuthJobData(jobName, data);
          await this.adapter.send(renderPasswordResetEmail(parsed));
          return;
        }
        case EMAIL_JOB_NAMES.emailVerification: {
          const parsed = parseAuthJobData(jobName, data);
          await this.adapter.send(renderEmailVerificationEmail(parsed));
          return;
        }
        case EMAIL_JOB_NAMES.invitation: {
          const parsed = parseInvitationJobData(jobName, data);
          await this.adapter.send(renderInvitationEmail(parsed));
          return;
        }
        default:
          throw new UnknownEmailJobError(jobName);
      }
    });
  }
}

function parseAuthJobData(jobName: string, data: unknown): EmailJobData {
  const result = emailJobSchema.safeParse(data);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issue = firstIssue
      ? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
      : "validation failed";
    throw new MalformedEmailJobError(jobName, issue);
  }
  return result.data;
}

function parseInvitationJobData(jobName: string, data: unknown): InvitationJobData {
  const result = invitationJobSchema.safeParse(data);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issue = firstIssue
      ? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
      : "validation failed";
    throw new MalformedEmailJobError(jobName, issue);
  }
  return result.data;
}
