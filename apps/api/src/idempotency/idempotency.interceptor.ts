/**
 * IdempotencyInterceptor — T520.
 *
 * NestJS interceptor that enforces HTTP idempotency for routes annotated
 * with `@Idempotent(policy)`.
 *
 * Flow (strategy.md §3.4.3):
 *   1. Read `@Idempotent` metadata. No metadata → pass through.
 *   2. Extract `Idempotency-Key` header; enforce policy (required → 400 if missing).
 *   3. Validate header format (16–128 chars, printable ASCII, no whitespace).
 *   4. Compose dedup tuple: `${method}:${route}:${clientId}:${key}`.
 *   5. Check in-progress marker. Present → 425 Too Early.
 *   6. Check IdempotencyKeyStore. Hit → return cached response (replay).
 *                                   Collision → 409 Conflict.
 *   7. Set in-progress marker.
 *   8. Invoke handler. On success → save to store; on any exit → clear marker.
 *
 * Redaction policy (strategy.md §15 / redaction-matrix):
 *   - Raw `Idempotency-Key` is NEVER logged. Only `key_fingerprint`
 *     (SHA-256 first 8 hex chars) may appear in structured logs.
 *
 * Replay path short-circuits BEFORE the handler → no second audit event
 * (strategy.md §6.4). `AuditEmitterInterceptor` is a global APP_INTERCEPTOR
 * but the `invite` route has no `@Auditable` decorator, so audit is a
 * no-op on that route regardless.
 *
 * Constitution §VII / FR-D-001 / FR-D-002 / FR-D-007 / FR-D-009.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash } from "node:crypto";
import { EMPTY, Observable, from, of } from "rxjs";
import { switchMap, tap } from "rxjs/operators";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import type { StoredResult } from "@data-pulse-2/shared";

import type { ResolvedContext } from "../context/types";
import {
  IDEMPOTENT_OPTIONS_KEY,
  IDEMPOTENT_POLICY_KEY,
  type IdempotentOptions,
  type IdempotentPolicy,
} from "./idempotent.decorator";
import {
  DEFAULT_INFLIGHT_TTL_SEC,
  InProgressMarker,
} from "./in-progress-marker";
import {
  recordIdempotencyConflict,
  recordIdempotencyInProgress,
  recordIdempotencyReplay,
} from "../observability/metrics/api.metrics";

export const IDEMPOTENCY_KEY_STORE = Symbol.for("api.idempotency.store");

/** Header name — case-insensitive per RFC. Express lowercases incoming headers. */
const HEADER_NAME = "idempotency-key";

/** Valid printable ASCII, no whitespace, 16–128 chars. */
const KEY_REGEX = /^[\x21-\x7E]{16,128}$/;

/** Route template used in the dedup tuple — method + path template. */
function routeTemplate(ctx: ExecutionContext): string {
  const req = ctx.switchToHttp().getRequest<{ method: string; route?: { path?: string }; url: string }>();
  const method = req.method.toUpperCase();
  const path = req.route?.path ?? req.url;
  return `${method}:${path}`;
}

/**
 * Extract clientId from the resolved context.
 * Falls back to "anonymous" only when the tenant context is absent
 * (should never happen on routes that use TenantContextGuard).
 */
function clientId(ctx: ExecutionContext): string {
  const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
  return req.context?.userId ?? req.principal?.userId ?? "anonymous";
}

function tenantId(ctx: ExecutionContext): string | null {
  const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
  return req.context?.tenantId ?? null;
}

/** SHA-256 of a string, returned as a Buffer. */
function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** First 8 hex chars of SHA-256 of the header value — safe to log. */
function keyFingerprint(headerValue: string): string {
  return createHash("sha256").update(headerValue).digest("hex").slice(0, 8);
}

/** Canonical JSON fingerprint of the request body. */
function bodyFingerprint(body: unknown): Buffer {
  return sha256Buffer(JSON.stringify(body ?? null));
}

/** Composed dedup tuple string (strategy.md §4.2). */
function composeTuple(
  method: string,
  routePath: string,
  cId: string,
  headerKey: string,
): string {
  return `${method}:${routePath}:${cId}:${headerKey}`;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_KEY_STORE) private readonly store: IdempotencyKeyStore,
    private readonly marker: InProgressMarker,
  ) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policy = this.reflector.get<IdempotentPolicy | undefined>(
      IDEMPOTENT_POLICY_KEY,
      execCtx.getHandler(),
    );

    // No @Idempotent decorator → pass through.
    if (!policy) {
      return next.handle();
    }

    const options = this.reflector.get<IdempotentOptions>(
      IDEMPOTENT_OPTIONS_KEY,
      execCtx.getHandler(),
    ) ?? {};

    return from(this.handle(execCtx, next, policy, options)).pipe(
      switchMap((obs) => obs),
    );
  }

  private async handle(
    execCtx: ExecutionContext,
    next: CallHandler,
    policy: IdempotentPolicy,
    options: IdempotentOptions,
  ): Promise<Observable<unknown>> {
    const req = execCtx.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();

    const rawKey = req.headers[HEADER_NAME];
    const headerValue = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Step 2: enforce policy for missing header
    if (!headerValue) {
      if (policy === "required") {
        throw new BadRequestException({
          code: "idempotency_key_required",
          message:
            "This endpoint requires an Idempotency-Key header. Generate a UUIDv7 and include it with every retry.",
        });
      }
      // optional: pass through without replay protection
      return next.handle();
    }

    // Step 3: validate header format
    if (!KEY_REGEX.test(headerValue)) {
      throw new BadRequestException({
        code: "idempotency_key_malformed",
        message:
          "Idempotency-Key must be 16–128 printable ASCII characters with no whitespace.",
      });
    }

    const method = req.method.toUpperCase();
    const routePath = req.route?.path ?? req.url;
    const cId = clientId(execCtx);
    const tId = tenantId(execCtx) ?? "no-tenant";
    const route = `${method}:${routePath}`;

    const tuple = composeTuple(method, routePath, cId, headerValue);
    const fp = bodyFingerprint(req.body);

    // Step 5: check in-progress marker BEFORE store lookup.
    const inflightTtlSec = options.inflightTtlSec ?? DEFAULT_INFLIGHT_TTL_SEC;
    const markerOwned = await this.marker.trySet(tuple, inflightTtlSec);

    if (!markerOwned) {
      // Another request is in flight for this tuple.
      recordIdempotencyInProgress({ route });
      // Write the response directly and return EMPTY so NestJS does not
      // attempt a second serialization pass (EMPTY completes with no values).
      const rawRes = execCtx.switchToHttp().getResponse<{
        status(code: number): unknown;
        setHeader(name: string, value: string): void;
        headersSent: boolean;
        json(body: unknown): void;
      }>();
      rawRes.setHeader("Retry-After", "2");
      rawRes.status(425 as unknown as number);
      rawRes.json({ error: "idempotency_in_progress", retryAfterSec: 2 });
      return EMPTY;
    }

    try {
      // Step 6: check IdempotencyKeyStore.
      const replayTtlMs =
        options.replayTtlSec !== undefined
          ? options.replayTtlSec * 1000
          : 72 * 60 * 60 * 1000; // 72h default

      const stored = await this.store.findOrCreate(
        tId,
        null,
        cId,
        tuple,
        fp,
      );

      if (stored.hit === true) {
        // Replay path — short-circuit before handler.
        await this.marker.del(tuple);
        recordIdempotencyReplay({ route });
        const entry = stored.entry;
        const rawRes = execCtx.switchToHttp().getResponse<{
          status(code: number): unknown;
          setHeader(name: string, value: string): void;
          json(body: unknown): void;
        }>();
        rawRes.setHeader("Idempotent-Replayed", "true");
        rawRes.status(entry.result.status);
        rawRes.json(entry.result.body);
        return EMPTY;
      }

      if (stored.hit === "collision") {
        // Same key, different body — conflict.
        await this.marker.del(tuple);
        recordIdempotencyConflict({ route });
        throw new ConflictException({
          code: "idempotency_key_conflict",
          message:
            "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
        });
      }

      // Step 7 already done (marker set above). Step 8: invoke handler.
      const expiresAt = new Date(Date.now() + replayTtlMs);
      const _fp = fp;
      const _kf = keyFingerprint(headerValue);
      void _kf; // used only in logs (not currently emitted to avoid PII)

      return next.handle().pipe(
        tap({
          next: async (responseBody: unknown) => {
            // Save the successful response for future replays.
            const result: StoredResult = {
              status: HttpStatus.CREATED,
              body: responseBody,
            };
            await this.store.save(
              tId,
              null,
              cId,
              tuple,
              _fp,
              result,
              expiresAt,
            ).catch(() => undefined); // best-effort
          },
          finalize: () => {
            // Best-effort marker cleanup on any exit (success or error).
            this.marker.del(tuple).catch(() => undefined);
          },
        }),
      );
    } catch (err) {
      // If we set the marker but then hit a store error, clean up.
      await this.marker.del(tuple).catch(() => undefined);
      throw err;
    }
  }
}
