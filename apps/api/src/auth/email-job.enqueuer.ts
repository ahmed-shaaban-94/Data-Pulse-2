/**
 * EmailJobEnqueuer — interface for placing email jobs onto the worker
 * queue. The real BullMQ-backed `EmailQueueProducer` lands in T112/T113
 * (and the matching email worker in T114/T115). This file only defines
 * the seam.
 *
 * Slice 3c uses a NoOp default so the controller is contract-compliant
 * (returns 202 / 204 for the request endpoints) without delivering any
 * email. The names are intentionally explicit — any production wiring
 * MUST replace the NoOp before this code goes near a customer.
 */
import { Injectable } from "@nestjs/common";

export interface PasswordResetEmailJob {
  /** The user's email address (already normalised to lowercase). */
  readonly email: string;
  /** The opaque raw token to be embedded in the reset link. */
  readonly rawToken: string;
  /** The user's id; useful for audit / dedupe but never displayed. */
  readonly userId: string;
}

export interface EmailVerificationEmailJob {
  readonly email: string;
  readonly rawToken: string;
  readonly userId: string;
}

/**
 * The seam. Implementations enqueue a worker job; they MUST NOT block
 * the request path on actual SMTP / API delivery — that work happens
 * in the worker (T114/T115).
 */
export interface EmailJobEnqueuer {
  enqueuePasswordReset(job: PasswordResetEmailJob): Promise<void>;
  enqueueEmailVerification(job: EmailVerificationEmailJob): Promise<void>;
}

/**
 * `NoOpEmailJobEnqueuer` — explicitly, loudly does nothing.
 *
 * Wired by `AuthModule` until T112/T113 lands the BullMQ producer.
 * Tests substitute a Jest spy via NestJS's `overrideProvider`. Production
 * deployments MUST swap this out before going live; the class name is
 * deliberately unsubtle so a dependency graph reviewer will catch it.
 */
@Injectable()
export class NoOpEmailJobEnqueuer implements EmailJobEnqueuer {
  async enqueuePasswordReset(_job: PasswordResetEmailJob): Promise<void> {
    // intentionally empty — no email is sent, no job is queued
  }
  async enqueueEmailVerification(
    _job: EmailVerificationEmailJob,
  ): Promise<void> {
    // intentionally empty — no email is sent, no job is queued
  }
}

/**
 * DI token for the enqueuer. AuthModule binds it to NoOpEmailJobEnqueuer.
 * Tests bind it to a Jest spy via `.overrideProvider(EMAIL_JOB_ENQUEUER)`.
 */
export const EMAIL_JOB_ENQUEUER = "EMAIL_JOB_ENQUEUER";
