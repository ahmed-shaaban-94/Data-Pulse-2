/**
 * EmailQueueProducer — slice 4 (T113).
 *
 * Concrete `EmailJobEnqueuer` implementation backed by a BullMQ `Queue`
 * named `email`. The matching email worker / processor lands in T114
 * and T115 (in `apps/worker`); this slice ships the producer side only,
 * which is sufficient for the auth controller's password-reset and
 * email-verification flows to record real jobs in Redis.
 *
 * No email is sent here. No SMTP / API call is made here. The producer
 * just writes a job description into the queue; the worker will pick it
 * up later, render the message body, and call out to the email provider.
 *
 * Idempotency
 * -----------
 * BullMQ deduplicates jobs by their `jobId`: if a job with that id
 * already exists in the queue, `Queue#add` returns the existing job
 * instead of creating a new one. We derive the `jobId` deterministically
 * from `(scope, sha256(rawToken))` so:
 *
 *   - The same raw token enqueued twice (e.g., a retried HTTP call,
 *     or a controller that issues twice on a double-click) collapses
 *     to a single job.
 *   - Different raw tokens produce different jobIds.
 *   - The scope prefix (`pwreset` / `verify`) namespaces the two
 *     job types so an accidental hash collision can't cross-route.
 *   - The jobId reveals NO PII: no email, no userId, no raw token —
 *     just a 32-char hash slice and a short scope literal. Anything
 *     legible in queue dashboards stays opaque.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Queue } from "bullmq";
import { injectTraceContext } from "@data-pulse-2/shared/observability/otel";
import {
  type EmailJobEnqueuer,
  type EmailVerificationEmailJob,
  type InvitationEmailJob,
  type PasswordResetEmailJob,
} from "./email-job.enqueuer";

/**
 * BullMQ job names. Workers (T114/T115) will subscribe to these
 * specific names on the same `email` queue.
 */
export const EMAIL_JOB_NAMES = {
  passwordReset: "auth.password-reset",
  emailVerification: "auth.email-verify",
  invitation: "memberships.invitation",
} as const;

/**
 * jobId scope prefixes. Short tokens — they appear in BullMQ dashboards
 * and structured logs.
 */
const JOB_ID_SCOPES = {
  passwordReset: "pwreset",
  emailVerification: "verify",
  invitation: "invite",
} as const;

/**
 * Minimal `Queue` surface this producer relies on. Defining it here
 * keeps the unit spec free of any BullMQ runtime — tests pass an
 * in-memory fake that records calls — and documents exactly which
 * BullMQ method we depend on.
 *
 * `close()` is OPTIONAL so existing in-memory test doubles continue to
 * work without a no-op stub; the producer's `onModuleDestroy` checks for
 * the method before invoking it (see class below). Real `bullmq.Queue`
 * always exposes `close()`.
 */
export interface QueueLike {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * EmailQueueProducer owns the underlying BullMQ `Queue`'s background
 * connection lifetime in production (`emailJobEnqueuerFactory` constructs
 * the Queue and hands it in here, with no other owner). Nest's
 * `OnModuleDestroy` lifecycle hook lets us close that connection cleanly
 * when the module shuts down -- without this hook, the queue's background
 * ioredis client survives Nest's `app.close()` and Jest reports
 * "worker process has failed to exit gracefully" at suite teardown,
 * which CI's exit-code aggregation flips from warning to error past a
 * leak-count threshold (observed on PR #240). See branch
 * `fix/api-queue-producers-close-on-destroy`.
 */
@Injectable()
export class EmailQueueProducer
  implements EmailJobEnqueuer, OnModuleDestroy
{
  private closed = false;

  constructor(private readonly queue: Queue | QueueLike) {}

  async enqueuePasswordReset(job: PasswordResetEmailJob): Promise<void> {
    const jobId = deriveJobId(JOB_ID_SCOPES.passwordReset, job.rawToken);
    await this.queue.add(
      EMAIL_JOB_NAMES.passwordReset,
      { ...job, traceContext: injectTraceContext() },
      { jobId },
    );
  }

  async enqueueEmailVerification(
    job: EmailVerificationEmailJob,
  ): Promise<void> {
    const jobId = deriveJobId(JOB_ID_SCOPES.emailVerification, job.rawToken);
    await this.queue.add(
      EMAIL_JOB_NAMES.emailVerification,
      { ...job, traceContext: injectTraceContext() },
      { jobId },
    );
  }

  async enqueueInvitation(job: InvitationEmailJob): Promise<void> {
    const jobId = deriveJobId(JOB_ID_SCOPES.invitation, job.rawToken);
    await this.queue.add(
      EMAIL_JOB_NAMES.invitation,
      { ...job, traceContext: injectTraceContext() },
      { jobId },
    );
  }

  /**
   * Close the underlying BullMQ Queue on module shutdown.
   *
   * Idempotent + defensive — see the matching docstring on
   * `AuditQueueProducer.onModuleDestroy` for the full rationale and
   * lineage to PR #240's CI leak.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closeFn = (this.queue as QueueLike).close;
    if (typeof closeFn === "function") {
      try {
        await closeFn.call(this.queue);
      } catch {
        // Best-effort shutdown. See AuditQueueProducer counterpart.
      }
    }
  }
}

/**
 * Build the deterministic jobId. Exported so the spec can assert
 * derivation symmetry without re-implementing the hash inline.
 */
export function deriveJobId(scope: string, rawToken: string): string {
  const hashHex = createHash("sha256").update(rawToken, "utf8").digest("hex");
  return `${scope}:${hashHex.slice(0, 32)}`;
}
