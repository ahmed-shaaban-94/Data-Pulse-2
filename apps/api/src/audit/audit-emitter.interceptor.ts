/**
 * AuditEmitterInterceptor — T231.
 *
 * Taps the response Observable of any route decorated with `@Auditable(action)`
 * and enqueues one `AuditJobPayload` per successful response via the injected
 * `AuditJobEnqueuer`.
 *
 * No-op fast path
 * ---------------
 * Routes without `@Auditable` pass through untouched — `Reflector.get` returns
 * `undefined` and we return `next.handle()` unchanged. This is intentional:
 * the majority of routes are not auditable, and the cost of a Reflector lookup
 * is negligible.
 *
 * Tenant / store derivation — response-body strategy
 * ---------------------------------------------------
 * `ContextController` endpoints deliberately do NOT mount `TenantContextGuard`
 * (chicken-and-egg: they establish the active tenant, so they cannot require
 * one). Consequently `request.context` is absent on those routes.
 *
 * For context-switch actions the interceptor therefore derives `tenant_id` and
 * `store_id` from the **response body** (`ContextResponseBody.active_tenant.id`,
 * `active_store.id`). This is more honest than the request body — the response
 * reflects what was actually applied to the session.
 *
 * Routes that DO mount `TenantContextGuard` can choose either strategy; the
 * `@Auditable` decorator opts a handler into audit emission and the interceptor
 * selects the body-based path when `request.context` is absent.
 *
 * Error isolation
 * ---------------
 * Enqueue errors are caught and logged; they MUST NOT surface as HTTP errors.
 * An audit emission failure is non-fatal — it is not preferable to reject the
 * original request over it.
 *
 * Not globally registered in this slice
 * --------------------------------------
 * KNOWN GAP: This interceptor is complete and testable but is NOT added to the
 * global interceptor chain in `main.ts` and is NOT included in any module. That
 * wiring is T232/T233's responsibility (AuditModule + BullMQ-backed enqueuer).
 * Until then, `@Auditable` decorators on controller methods have no runtime
 * effect in production. Tests mount the interceptor directly on a fake
 * controller and are unaffected by this gap.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Logger } from "@data-pulse-2/shared";
import type { Observable } from "rxjs";
import { tap } from "rxjs";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import type { AuthedRequest } from "../auth/auth.guard";
import type { ContextResponseBody } from "../context/context.service";
import { AUDITABLE_KEY } from "./auditable.decorator";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "./audit-job.enqueuer";
import type { AuditJobPayload } from "./audit-job.types";

@Injectable()
export class AuditEmitterInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly enqueuer: AuditJobEnqueuer,
    @Optional() @Inject(ROOT_LOGGER)
    private readonly logger?: Logger,
  ) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.get<string | undefined>(
      AUDITABLE_KEY,
      execCtx.getHandler(),
    );

    if (!action) {
      return next.handle();
    }

    const request = execCtx.switchToHttp().getRequest<AuthedRequest & {
      context?: { tenantId: string | null; storeId: string | null };
    }>();

    return next.handle().pipe(
      tap({
        next: (responseBody: unknown) => {
          this.emitAsync(action, request, responseBody).catch((err: unknown) => {
            this.logger?.error({ err, action }, "AuditEmitter: enqueue failed");
          });
        },
      }),
    );
  }

  private async emitAsync(
    action: string,
    request: AuthedRequest & { context?: { tenantId: string | null; storeId: string | null } },
    responseBody: unknown,
  ): Promise<void> {
    const principal = request.principal;
    const actorUserId = principal?.userId ?? null;
    const actorLabel: string | null = null;

    // Derive tenant/store from response body when request.context is absent
    // (ContextController routes — see module docstring above).
    let tenantId: string | null = request.context?.tenantId ?? null;
    let storeId: string | null = request.context?.storeId ?? null;

    if (tenantId === null && isContextResponseBody(responseBody)) {
      tenantId = responseBody.active_tenant?.id ?? null;
      storeId = responseBody.active_store?.id ?? null;
    }

    const payload: AuditJobPayload = {
      actor_user_id: actorUserId,
      actor_label: actorLabel,
      tenant_id: tenantId,
      store_id: storeId,
      action,
      target_type: null,
      target_id: null,
      request_id: request.requestId ?? null,
      metadata: null,
    };

    await this.enqueuer.enqueue(payload);
  }
}

function isContextResponseBody(
  value: unknown,
): value is Pick<ContextResponseBody, "active_tenant" | "active_store"> {
  if (typeof value !== "object" || value === null) return false;
  return "active_tenant" in value;
}
