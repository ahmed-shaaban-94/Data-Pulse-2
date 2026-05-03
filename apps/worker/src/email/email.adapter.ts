/**
 * EmailAdapter — slice 5 (T115).
 *
 * Provider-agnostic seam. Concrete implementations (SES, SendGrid,
 * Postmark, Resend, nodemailer/SMTP, ...) plug in behind this interface
 * — none is chosen yet (PQ-1 stub in the spec). The processor depends
 * only on this interface, so swapping providers later is a one-class
 * change with zero blast radius into the worker domain logic.
 *
 * Why so minimal?
 * ---------------
 *   - `to / subject / textBody / htmlBody` is the lowest-common-
 *     denominator shape across every major transactional-email API.
 *   - `tags` are for provider-side analytics dashboards; they MUST NOT
 *     contain PII. (Templates put rawToken/userId/email only into the
 *     body and `to`; never into `tags`.)
 *   - No headers, no attachments, no MIME — no production driver yet
 *     needs them, and adding now would be premature design.
 *   - No retry logic in the adapter. BullMQ owns retry/backoff/DLQ
 *     (see T301). Adapter throws → BullMQ retries.
 *
 * What is deferred to a later slice?
 * ----------------------------------
 *   - Real provider SDK selection and wiring (PQ-1, future feature).
 *   - BullMQ `Worker` bootstrap, Redis connection, graceful shutdown
 *     (Phase 2 task T090).
 *   - Retry / backoff / DLQ policy across queues (Phase 10 task T301).
 *
 * The `NoOpEmailAdapter` is the wired default until a provider is
 * chosen. The class name is intentionally loud so a dependency-graph
 * reviewer will catch any deployment that ships it.
 */
import { Injectable } from "@nestjs/common";

export interface EmailMessage {
  /** RFC-5322 address. The processor validates the payload before this is built. */
  readonly to: string;
  /** Plain, non-empty. Providers reject empty subjects. */
  readonly subject: string;
  /** Plain-text fallback. Mandatory — providers fall back to it for plain-text clients. */
  readonly textBody: string;
  /** Optional HTML body for rich clients. */
  readonly htmlBody?: string;
  /**
   * Provider-side analytics labels. MUST NOT contain PII (no email, no
   * userId, no rawToken). Safe values: `template_id`, `category`, etc.
   */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface EmailAdapter {
  /**
   * Send a fully-rendered message. Implementations:
   *   - MUST NOT retry internally — BullMQ owns retry policy.
   *   - MUST throw on transport failure so BullMQ can reschedule.
   *   - SHOULD be idempotent in the sense that the same message can be
   *     re-sent without side effects beyond the email itself (BullMQ
   *     dedupes jobs upstream by `jobId`, which is set by the producer).
   */
  send(message: EmailMessage): Promise<void>;
}

/**
 * DI token for the adapter. Wired by a future worker module to either
 * `NoOpEmailAdapter` (default) or a real provider impl. Tests pass an
 * adapter instance directly to the `EmailProcessor` constructor and do
 * not rely on Nest DI.
 */
export const EMAIL_ADAPTER = "EMAIL_ADAPTER";

/**
 * `NoOpEmailAdapter` — explicitly, loudly does nothing.
 *
 * The default until a real provider lands (PQ-1). Production deployments
 * MUST swap this out before going live; the class name is unsubtle on
 * purpose.
 */
@Injectable()
export class NoOpEmailAdapter implements EmailAdapter {
  async send(_message: EmailMessage): Promise<void> {
    // intentionally empty — no provider chosen yet (PQ-1)
  }
}

/**
 * `RecordingEmailAdapter` — in-memory test double.
 *
 * Captures every `send` for assertion. Set `.reject` to make the next
 * `send` throw, mirroring transport failure for retry-path tests.
 */
export class RecordingEmailAdapter implements EmailAdapter {
  readonly sent: EmailMessage[] = [];
  reject?: Error;

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    if (this.reject) throw this.reject;
  }
}
