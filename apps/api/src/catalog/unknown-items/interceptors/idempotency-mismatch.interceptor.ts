/**
 * IdempotencyMismatchInterceptor — 005-WAVE1-METRICS-MISMATCH-FOLLOWUP PR 2.
 *
 * NestJS interceptor that intercepts the `ConflictException` thrown by the
 * 001 `IdempotencyInterceptor` when a previously-seen `Idempotency-Key` is
 * reused with a different request body (`idempotency.interceptor.ts:272-276`).
 * Uses RxJS `tap({ error: ... })` to:
 *
 *   1. Increment the catalog-domain `idempotency_token_mismatch_total`
 *      counter (FR-021c observability).
 *   2. Enqueue an audit event with action
 *      `unknown_item.idempotency_mismatch_rejected` (FR-082).
 *
 * The error continues propagating to GlobalExceptionFilter unchanged, which
 * formats the 409 envelope (Constitution §IV — honors user-supplied
 * fine-grained code "idempotency_key_conflict").
 *
 * REPLACES the prior `IdempotencyMismatchFilter` (deleted in this PR). The
 * filter pattern (async `@Catch(ConflictException)` + re-throw) was the only
 * async exception filter in the codebase with no working precedent; PR #386
 * boundary-evidence (recorded in `wave-status.md` §"Investigation update —
 * 2026-05-28 (PR #386 CI evidence)") confirmed the async re-throw never
 * propagated to GlobalExceptionFilter. This interceptor mirrors the working
 * pattern of `AuditEmitterInterceptor` (apps/api/src/audit/audit-emitter.interceptor.ts):
 * `next.handle().pipe(tap({ ... }))` + fire-and-forget enqueue. Restores
 * single-filter pipeline parity with 001's working `conflict.spec.ts`.
 *
 * Method-scoping invariant (PRESERVED from the filter): the interceptor is
 * applied ONLY via `@UseInterceptors(IdempotencyMismatchInterceptor)` on the
 * `posCaptureItem` route. Other routes on the controller (LIST, DISMISS,
 * future Wave 2 reconciliation routes) MUST NOT inherit this telemetry —
 * their 409s use different codes (e.g. `alias_conflict`) and would be
 * mis-labelled. NOT registered as `APP_INTERCEPTOR`.
 *
 * Narrow code check (PRESERVED): only fires for
 * `code === "idempotency_key_conflict"`. Other 409 codes on the capture
 * route (none today; Wave 2 may add some) pass through unchanged.
 *
 * Audit payload construction mirrors `AuditEmitterInterceptor`
 * (`audit-emitter.interceptor.ts:101-122`):
 *   - actor_user_id ← request.principal?.userId
 *   - tenant_id     ← request.context?.tenantId
 *   - store_id      ← request.context?.storeId
 *   - request_id    ← request.requestId
 *   - target_type / target_id / metadata: null (no specific target row exists)
 *
 * Fire-and-forget enqueue (FR-021c determinism):
 *   The enqueue promise is NOT awaited inside the tap-error handler. If the
 *   audit pipeline rejects (BullMQ outage, Redis disconnect), the `.catch()`
 *   on the unawaited promise logs the failure via the optional logger but
 *   does NOT alter the response shape. The 409 contract is deterministic
 *   and must not be replaced by audit-pipeline failures.
 *
 * See:
 *   spec.md FR-021c / FR-082
 *   docs/observability/signals.md §1.1 (idempotency_token_mismatch_total)
 *   wave-status.md §"Investigation update — 2026-05-28 (PR #386 CI evidence)"
 */
import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Optional,
} from "@nestjs/common";
import type { Request } from "express";
import { type Observable, tap } from "rxjs";

import type { Logger } from "@data-pulse-2/shared";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../audit/audit-job.types";
import { ROOT_LOGGER } from "../../../common/logging.interceptor";
import { recordIdempotencyTokenMismatch } from "../../../observability/metrics/api.metrics";

/**
 * Shape of a request augmented by upstream interceptors. Mirrors the fields
 * `AuditEmitterInterceptor` reads — kept narrow so the interceptor doesn't
 * transitively depend on every upstream interceptor's type export.
 */
type AugmentedRequest = Request & {
  context?: { tenantId: string | null; storeId: string | null };
  principal?: { userId?: string | null };
  requestId?: string;
};

@Injectable()
export class IdempotencyMismatchInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly enqueuer: AuditJobEnqueuer | null = null,
    @Optional()
    @Inject(ROOT_LOGGER)
    private readonly logger?: Logger,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      tap({
        error: (err: unknown) => this.handleError(err, ctx),
      }),
    );
  }

  private handleError(err: unknown, ctx: ExecutionContext): void {
    // Narrow: only act on the specific 409 the IdempotencyInterceptor throws
    // on payload mismatch. Other errors (incl. other 409s on this route in
    // future waves) pass through unchanged.
    if (!(err instanceof ConflictException)) return;
    const response = err.getResponse();
    const code =
      typeof response === "object" && response !== null
        ? (response as { code?: unknown }).code
        : undefined;
    if (code !== "idempotency_key_conflict") return;

    // FR-021c observability — catalog-axis counter. The 001 platform-axis
    // counter (`recordIdempotencyConflict`) already fired inside the
    // interceptor at the collision branch.
    recordIdempotencyTokenMismatch();

    // FR-082 — catalog-domain audit subject. Fire-and-forget; never override
    // the deterministic 409 contract with audit-pipeline failures.
    // Skipped when the audit enqueuer is not wired (legacy test fixtures —
    // capture-happy-path, capture-validation, etc., which never exercise
    // the mismatch path).
    if (this.enqueuer !== null) {
      const request = ctx.switchToHttp().getRequest<AugmentedRequest>();
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
      this.enqueuer.enqueue(payload).catch((enqErr: unknown) => {
        this.logger?.error(
          { err: enqErr, action: payload.action },
          "IdempotencyMismatchInterceptor: enqueue failed",
        );
      });
    }
    // tap.error handler returns void; original ConflictException continues
    // propagating to GlobalExceptionFilter unchanged.
  }
}
