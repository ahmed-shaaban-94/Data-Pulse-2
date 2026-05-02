import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { ErrorCodes, errorEnvelope, newId } from "@data-pulse-2/shared";
import type { Request, Response } from "express";
import { ZodError } from "zod";

/**
 * Map HTTP status codes to canonical error codes used in the envelope.
 * Anything not listed becomes `internal_error`.
 */
function statusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCodes.VALIDATION;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCodes.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCodes.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCodes.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCodes.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCodes.RATE_LIMITED;
    default:
      return ErrorCodes.INTERNAL;
  }
}

/**
 * Pull a usable `message` from an HttpException's response payload.
 * Nest stores the response as either a string or an object with a
 * `message` field (often a string or array of strings, e.g., from
 * ValidationPipe).
 */
function extractMessage(
  exception: HttpException,
  fallback: string,
): { message: string; details?: unknown } {
  const response = exception.getResponse();
  if (typeof response === "string") {
    return { message: response };
  }
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const msg = r["message"];
    if (typeof msg === "string") {
      return { message: msg, details: r["details"] };
    }
    if (Array.isArray(msg)) {
      return {
        message: msg.length > 0 ? String(msg[0]) : fallback,
        details: msg.length > 1 ? msg : undefined,
      };
    }
  }
  return { message: fallback };
}

/**
 * Global exception filter — formats every uncaught error into the uniform
 * `{ error: { code, message, request_id, details? } }` envelope.
 *
 * 403 and 404 share the envelope shape per FR-ISO-4. The decision of
 * which status to return for cross-tenant access lives in the future
 * tenant-context guard, not in this filter.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();
    const requestId = request.requestId ?? newId();

    if (exception instanceof ZodError) {
      const envelope = errorEnvelope({
        code: ErrorCodes.VALIDATION,
        message: "Request validation failed",
        requestId,
        details: exception.issues,
      });
      response.status(HttpStatus.BAD_REQUEST).json(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = statusToCode(status);
      const { message, details } = extractMessage(
        exception,
        statusDefaultMessage(status),
      );
      const envelope = errorEnvelope({
        code,
        message,
        requestId,
        ...(details !== undefined ? { details } : {}),
      });
      response.status(status).json(envelope);
      return;
    }

    // Unhandled — never leak internals to the client.
    const message =
      exception instanceof Error ? exception.message : "Internal Server Error";
    void message;
    const envelope = errorEnvelope({
      code: ErrorCodes.INTERNAL,
      message: "Internal Server Error",
      requestId,
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(envelope);
  }
}

function statusDefaultMessage(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "Bad Request";
    case HttpStatus.UNAUTHORIZED:
      return "Unauthorized";
    case HttpStatus.FORBIDDEN:
      return "Forbidden";
    case HttpStatus.NOT_FOUND:
      return "Not Found";
    case HttpStatus.CONFLICT:
      return "Conflict";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "Too Many Requests";
    default:
      return "Internal Server Error";
  }
}
