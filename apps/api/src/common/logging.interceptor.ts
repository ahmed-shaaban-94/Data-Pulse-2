import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { withRequestContext, type Logger } from "@data-pulse-2/shared";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";

/**
 * DI token for the root logger, registered in `app.module.ts` via
 * `provide: ROOT_LOGGER, useValue: createLogger(...)`.
 */
export const ROOT_LOGGER = Symbol.for("api.rootLogger");

/**
 * Logs one structured line per request, on response, with `request_id`
 * (from `RequestIdInterceptor`), `tenant_id` (null until the future
 * tenant-context guard populates it), `method`, `route`, `status`,
 * `latency_ms`. Secrets are redacted by the shared logger's `redact` list.
 *
 * Constitution VII: structured logs with `tenant_id`/`request_id`.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(ROOT_LOGGER) private readonly rootLogger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();

    const start = process.hrtime.bigint();
    const childLogger = withRequestContext(this.rootLogger, {
      request_id: request.requestId ?? "unknown",
      tenant_id: null,
      user_id: null,
      store_id: null,
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
