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
 * Lazy-queue provider thunk. See the matching docstring on
 * `AuditQueueProducer` (`audit-queue.producer.ts`) for the full
 * rationale: production factory passes a thunk so the real BullMQ
 * Queue is NOT constructed at Nest module-init time, which would
 * leak past an `overrideProvider` that runs after init.
 */
export type EmailQueueProvider = () => Queue | QueueLike;

/**
 * EmailQueueProducer accepts EITHER a ready `Queue | QueueLike`
 * (eager: existing tests pass a FakeQueue directly) OR an
 * `EmailQueueProvider` thunk (lazy: production factory passes a thunk
 * that constructs the real BullMQ Queue on first enqueue).
 *
 * See `AuditQueueProducer` (`audit-queue.producer.ts`) for the full
 * rationale on lazy-init -- this class is the symmetric mirror with
 * identical semantics. The two producers were refactored together
 * so the override-orphan leak class is closed at both factory sites.
 */
@Injectable()
export class EmailQueueProducer
  implements EmailJobEnqueuer, OnModuleDestroy
{
  private closed = false;
  /** Materialised Queue. `null` while still lazy. */
  private queue: Queue | QueueLike | null;
  /** Thunk to build the Queue on first use; `null` once materialised. */
  private queueProvider: EmailQueueProvider | null;

  /**
   * Eager: pass a ready `Queue | QueueLike`. Used by unit specs and
   * by call sites where the queue is already constructed.
   *
   * Lazy: pass an `EmailQueueProvider` thunk. Used by the production
   * `emailJobEnqueuerFactory` so the BullMQ Queue is NOT constructed
   * at Nest module-init time.
   */
  constructor(queueOrProvider: Queue | QueueLike | EmailQueueProvider) {
    if (typeof queueOrProvider === "function") {
      this.queue = null;
      this.queueProvider = queueOrProvider;
    } else {
      this.queue = queueOrProvider;
      this.queueProvider = null;
    }
  }

  /**
   * Materialise the underlying Queue on first use.
   *
   * Post-destroy guard
   * ------------------
   * CodeRabbit review on PR #242: the previous implementation
   * (`this.queue ?? (this.queue = this.queueProvider!())`) would
   * happily invoke the provider thunk AFTER `onModuleDestroy()` set
   * `this.closed = true`. In production that creates a fresh BullMQ
   * Queue plus background ioredis client which `onModuleDestroy` has
   * already short-circuited past -- a brand-new resource leak that
   * is the exact opposite of what the lazy refactor was designed to
   * prevent.
   *
   * Order of checks:
   *   1. Queue already materialised → return it (fast path).
   *   2. Producer is closed → throw. Caller MUST NOT enqueue against
   *      a destroyed producer; surfacing this loudly is the only way
   *      to catch latent post-destroy emissions (e.g. an async cleanup
   *      hook that fires after `app.close()`).
   *   3. Provider thunk is null → throw a defensive Error. In normal
   *      flows this is unreachable -- the constructor sets one of
   *      `queue` / `queueProvider`, and the materialisation path
   *      below nulls `queueProvider` only AFTER setting `queue`.
   *   4. Materialise via the thunk and clear `queueProvider` so we
   *      cannot accidentally invoke it twice (and so the GC can free
   *      any closure state the thunk was holding).
   */
  private ensureQueue(): Queue | QueueLike {
    if (this.queue !== null) return this.queue;
    if (this.closed) {
      throw new Error("EmailQueueProducer is closed");
    }
    if (this.queueProvider === null) {
      throw new Error(
        "EmailQueueProducer queue provider is unavailable (lazy invariant violated)",
      );
    }
    const q = this.queueProvider();
    this.queue = q;
    this.queueProvider = null;
    return q;
  }

  async enqueuePasswordReset(job: PasswordResetEmailJob): Promise<void> {
    const jobId = deriveJobId(JOB_ID_SCOPES.passwordReset, job.rawToken);
    const queue = this.ensureQueue();
    await queue.add(
      EMAIL_JOB_NAMES.passwordReset,
      { ...job, traceContext: injectTraceContext() },
      { jobId },
    );
  }

  async enqueueEmailVerification(
    job: EmailVerificationEmailJob,
  ): Promise<void> {
    const jobId = deriveJobId(JOB_ID_SCOPES.emailVerification, job.rawToken);
    const queue = this.ensureQueue();
    await queue.add(
      EMAIL_JOB_NAMES.emailVerification,
      { ...job, traceContext: injectTraceContext() },
      { jobId },
    );
  }

  async enqueueInvitation(job: InvitationEmailJob): Promise<void> {
    const jobId = deriveJobId(JOB_ID_SCOPES.invitation, job.rawToken);
    const queue = this.ensureQueue();
    await queue.add(
      EMAIL_JOB_NAMES.invitation,
      { ...job, traceContext: injectTraceContext() },
      { jobId },
    );
  }

  /**
   * Close the underlying BullMQ Queue on module shutdown.
   *
   * Idempotent + defensive + lazy-aware -- see the matching docstring
   * on `AuditQueueProducer.onModuleDestroy` for the full rationale.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.queue === null) {
      // Lazy, never materialised. Drop the provider thunk too so a
      // subsequent `enqueue*` cannot resurrect the queue via the
      // `ensureQueue` materialisation path (post-destroy guard --
      // CodeRabbit review on PR #242).
      this.queueProvider = null;
      return;
    }
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
  // Separator is "-" not ":" — BullMQ 5.x's Job.validateOptions rejects
  // custom jobIds containing ":". The colon-form caused every successful
  // authenticated invite / password-reset / email-verify request to
  // return 500 from the enqueue boundary; see PR #287 §10.
  return `${scope}-${hashHex.slice(0, 32)}`;
}
