/**
 * IdempotencyMismatchFilter — 005 Wave 1 / T533 (IDEMP-MISMATCH).
 *
 * NestJS exception filter that intercepts the `ConflictException` thrown
 * by the existing 001 `IdempotencyInterceptor` when a previously-seen
 * `Idempotency-Key` is reused with a different request body
 * (`idempotency.interceptor.ts:255-260`). On that specific 409:
 *
 *   1. Increment the catalog-domain `idempotency_token_mismatch_total`
 *      counter (FR-021c observability — registered in PR #299, the
 *      cross-spec metrics-allowlist slice).
 *   2. Enqueue an audit event with action
 *      `unknown_item.idempotency_mismatch_rejected` (FR-082 — failed
 *      reconciliation attempts are first-class audit events).
 *   3. Re-throw the original exception so the canonical envelope
 *      formatting in `GlobalExceptionFilter` runs unchanged.
 *
 * The 001 platform-level `recordIdempotencyConflict` metric fires
 * BEFORE this filter runs (it's emitted from inside the interceptor at
 * `idempotency.interceptor.ts:254`). Both counters fire on a mismatch
 * — that's intentional per tasks.md T532 ("in addition to the existing
 * `recordIdempotencyConflict` metric"). The 001 metric is platform-axis
 * observability (operator dashboards); the 005 counter is catalog-axis
 * observability (per-tenant capture-flow health).
 *
 * Scope (method-level via `@UseFilters` on `posCaptureItem`):
 *   This filter MUST NOT run on routes other than the POS capture
 *   route. A 409 from a future LIST / DISMISS / Wave 2 route would
 *   otherwise get the wrong audit subject (e.g. a Wave 2 alias-conflict
 *   would be mis-labeled as an idempotency mismatch). The `@UseFilters`
 *   decorator is applied at the method level on `posCaptureItem` only.
 *
 * Narrow code check:
 *   Even within the capture route, only 409s with
 *   `response.code === "idempotency_key_conflict"` should fire the
 *   catalog-domain telemetry. The filter checks this before doing any
 *   work; non-matching 409s fall through to a plain re-throw (no
 *   audit, no counter increment). Future Wave 2 alias-conflict 409s
 *   that land on the capture route via reconciliation would be
 *   distinguished by their own `code` value.
 *
 * Audit payload construction mirrors `AuditEmitterInterceptor`
 * (`apps/api/src/audit/audit-emitter.interceptor.ts:101-122`):
 *   - actor_user_id ← request.principal?.userId
 *   - tenant_id     ← request.context?.tenantId
 *   - store_id      ← request.context?.storeId
 *   - request_id    ← request.requestId
 *   - target_type / target_id / metadata: null (no specific target
 *     row exists — the request was rejected before any DB write)
 *
 * Fire-and-forget enqueue:
 *   The enqueue is awaited inside the filter so the audit event is
 *   queued BEFORE the exception propagates to GlobalExceptionFilter
 *   (which commits the response). This avoids the post-response race
 *   documented at `GlobalExceptionFilter:91`. The enqueuer is
 *   contractually non-blocking per its docstring; awaiting it
 *   shouldn't add measurable latency to the rejection path.
 *
 * See:
 *   tasks.md T532 / T533
 *   research.md §R2 (FR-091 failure taxonomy — "idempotency-token-mismatch")
 *   docs/observability/signals.md §1.1 (idempotency_token_mismatch_total)
 */
import {
  ArgumentsHost,
  Catch,
  ConflictException,
  type ExceptionFilter,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type { Request } from "express";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../audit/audit-job.types";
import { recordIdempotencyTokenMismatch } from "../../../observability/metrics/api.metrics";

/**
 * Shape of a request augmented by upstream interceptors. Mirrors the
 * fields `AuditEmitterInterceptor` reads — kept narrow so the filter
 * doesn't transitively depend on every interceptor's type export.
 */
type AugmentedRequest = Request & {
  context?: { tenantId: string | null; storeId: string | null };
  principal?: { userId?: string | null };
  requestId?: string;
};

@Injectable()
@Catch(ConflictException)
export class IdempotencyMismatchFilter implements ExceptionFilter {
  /**
   * The audit enqueuer is `@Optional()` so legacy test fixtures that
   * bootstrap `UnknownItemsController` without the audit module DI
   * graph (capture-happy-path, capture-validation, etc.) don't have
   * to be updated to provide a no-op enqueuer. Those specs never
   * exercise the mismatch path — the filter only fires when the
   * IdempotencyInterceptor throws a `code: "idempotency_key_conflict"`
   * 409, which the unit-level controller-guard tests never trigger.
   *
   * Production wiring (`UnknownItemsModule` → `AuditModule`) provides
   * the real enqueuer. `retry-mismatch.spec.ts` provides a spy via
   * `overrideProvider(AUDIT_JOB_ENQUEUER)`. The fallback below is
   * only reachable when neither has wired the token AND the mismatch
   * path is invoked anyway — defensive logging would be appropriate
   * if that combination ever occurs; for now the catch silently
   * skips audit emission (the counter still fires, the exception
   * still propagates).
   */
  constructor(
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly enqueuer: AuditJobEnqueuer | null = null,
  ) {}

  async catch(exception: ConflictException, host: ArgumentsHost): Promise<void> {
    // [T532-DIAG B3] PR 1 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP. Diagnostic-only.
    // Logs whether the filter ever receives the ConflictException. If B1 fires
    // but B3 does NOT, the exception is escaping the filter pipeline upstream
    // of @UseFilters resolution. Remove in PR 2.
    if (process.env["T532_DIAG"] === "1") {
      // eslint-disable-next-line no-console
      console.log(
        `[T532-DIAG B3 filter catch entry] exception=${exception?.name} status=${exception?.getStatus?.()} ts=${Date.now()}`,
      );
    }
    // Narrow check — only run catalog-domain telemetry for the
    // specific 409 the IdempotencyInterceptor throws on payload
    // mismatch. Other 409s on this route (none today; Wave 2 may add
    // alias-conflict) pass through to GlobalExceptionFilter unchanged.
    const response = exception.getResponse();
    const code =
      typeof response === "object" && response !== null
        ? (response as { code?: unknown }).code
        : undefined;

    if (code !== "idempotency_key_conflict") {
      throw exception;
    }

    // FR-021c observability — increment the catalog-axis counter.
    // The 001 platform-axis counter (`recordIdempotencyConflict`)
    // already fired inside the interceptor at line 254.
    recordIdempotencyTokenMismatch();

    // FR-082 — emit the catalog-domain audit subject. Constructed
    // from the request principal + context, same shape as
    // AuditEmitterInterceptor produces for `@Auditable` decorators.
    // Skipped when the audit enqueuer is not wired (legacy test
    // fixtures — see constructor docstring).
    //
    // Best-effort enqueue (CodeRabbit feedback on PR #339): the
    // enqueuer can throw on transient audit-pipeline failures (BullMQ
    // outage, Redis disconnect, etc.). A thrown error here would
    // propagate out of `catch()` and replace the canonical
    // ConflictException, converting the deterministic 409 contract
    // into a 500. FR-021c requires a deterministic conflict outcome,
    // so audit emission MUST NOT alter the response shape. Swallow
    // enqueue failures and continue to the re-throw below.
    //
    // The pattern mirrors AuditEmitterInterceptor's own enqueue
    // handling (audit-emitter.interceptor.ts:91-93), which catches
    // enqueue failures and logs them via an optional logger. This
    // filter doesn't inject a logger to keep the slice scope tight;
    // a future enhancement could add `@Optional() @Inject(ROOT_LOGGER)`
    // to surface enqueue failures in operator dashboards.
    if (this.enqueuer !== null) {
      const request = host
        .switchToHttp()
        .getRequest<AugmentedRequest>();
      const payload: AuditJobPayload = {
        actor_user_id: request.principal?.userId ?? null,
        actor_label: null,
        tenant_id: request.context?.tenantId ?? null,
        store_id: request.context?.storeId ?? null,
        action: "unknown_item.idempotency_mismatch_rejected",
        target_type: null,
        target_id: null,
        request_id: request.requestId ?? null,
        metadata: null,
      };
      try {
        await this.enqueuer.enqueue(payload);
      } catch {
        // Best-effort: never override mismatch conflict semantics.
        // FR-021c determinism takes precedence over audit emission.
      }
    }

    // Re-throw so GlobalExceptionFilter formats the envelope. Post-PR
    // #360 the platform-level filter honors the interceptor's
    // user-supplied fine-grained code (Constitution §IV), so the wire
    // shape is
    //   `{ error: { code: "idempotency_key_conflict", message: "...", request_id, ... } }`.
    // The catalog-domain filter's only job is the catalog-domain
    // side-effects; the response shape stays in the platform-level filter.
    throw exception;
  }
}
