import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import {
  getCorrelationId,
  withRequestContext,
  type Logger,
} from "@data-pulse-2/shared";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import type { TenantContextRequest } from "../context/types";

/**
 * DI token for the root logger, registered in `app.module.ts` via
 * `provide: ROOT_LOGGER, useValue: createLogger(...)`.
 */
export const ROOT_LOGGER = Symbol.for("api.rootLogger");

/**
 * Logs one structured line per request, on response.
 *
 * Structured-log fields (FR-B-004 / Track B / P4 / T474):
 *   - `request_id`   — always (from `RequestIdInterceptor`)
 *   - `tenant_id`    — when established (from `TenantContextGuard`'s
 *                       `request.context.tenantId`, null otherwise)
 *   - `store_id`     — when established
 *   - `user_id`      — when authenticated
 *   - `actor_id`     — when authenticated (mirrors `user_id` for audit-
 *                       relevant call sites; matrix §3.4)
 *   - `correlation_id` — active OTel trace-id when one exists, else
 *                        falls back to `request_id`
 *
 * `request.context` is set synchronously by `TenantContextGuard.canActivate`
 * (which runs BEFORE interceptors); we can read it directly without ALS
 * bridging. Routes without that guard simply leave `request.context`
 * undefined and the structured fields stay null.
 *
 * Secrets / PII are redacted at the logger boundary by the shared
 * logger's `redact.paths` and per-emit-site serializers (T473).
 *
 * Constitution VII: structured logs with `tenant_id`/`request_id`.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(ROOT_LOGGER) private readonly rootLogger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<
      Request & { requestId?: string } & Partial<TenantContextRequest>
    >();
    const response = http.getResponse<Response>();

    const start = process.hrtime.bigint();
    const requestId = request.requestId ?? "unknown";
    const ctx = request.context;
    const childLogger = withRequestContext(this.rootLogger, {
      request_id: requestId,
      tenant_id: ctx?.tenantId ?? null,
      user_id: ctx?.userId ?? null,
      store_id: ctx?.storeId ?? null,
      actor_id: ctx?.userId ?? null,
      correlation_id: getCorrelationId(requestId),
    });

    return next.handle().pipe(
      tap({
        next: () => {
          const latencyNs = process.hrtime.bigint() - start;
          childLogger.info(
            {
              method: request.method,
              route: request.originalUrl ?? request.url,
              status: response.statusCode,
              latency_ms: Number(latencyNs / 1_000_000n),
            },
            "request completed",
          );
        },
        error: (err: unknown) => {
          const latencyNs = process.hrtime.bigint() - start;
          childLogger.error(
            {
              method: request.method,
              route: request.originalUrl ?? request.url,
              status: response.statusCode,
              latency_ms: Number(latencyNs / 1_000_000n),
              err,
            },
            "request errored",
          );
        },
      }),
    );
  }
}
