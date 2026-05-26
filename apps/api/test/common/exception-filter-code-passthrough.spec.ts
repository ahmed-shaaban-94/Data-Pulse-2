/**
 * exception-filter-code-passthrough.spec.ts
 *
 * Constitution §IV (OpenAPI contract-of-record) — `GlobalExceptionFilter`
 * MUST honor user-supplied fine-grained error codes when the throwing
 * site uses the structured form:
 *
 *   throw new ConflictException({ code: "alias_conflict", message: "..." })
 *
 * Pre-fix behavior (PR #360 root cause): the filter unconditionally
 * rewrote every `HttpException`'s `error.code` to the status-derived
 * canonical code (statusToCode), discarding fine-grained codes the
 * OpenAPI YAML specifies. This spec locks in the post-fix contract.
 *
 * Cases:
 *   CP1 — Structured 409 with `code: "alias_conflict"` → envelope honors it
 *   CP2 — Bare string 409 (no code field) → canonical "conflict" fallback
 *   CP3 — Structured 404 with `code: "tenant_not_found"` → envelope honors it
 *   CP4 — ZodError handling is UNAFFECTED (still `validation_error`)
 *   CP5 — Structured throw with both `code` AND `details` → both surface
 */
import "reflect-metadata";

import {
  ConflictException,
  HttpStatus,
  NotFoundException,
  type ArgumentsHost,
} from "@nestjs/common";
import { z } from "zod";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

function makeMockHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const response = {
    headersSent: false,
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  const request = {
    requestId: "test-req-id-passthrough",
    route: { path: "/test/passthrough" },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getClass: () => undefined,
    getHandler: () => undefined,
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe("GlobalExceptionFilter — code passthrough (Constitution §IV)", () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  // CP1 — structured 409 with user-supplied fine-grained code
  it("CP1: honors user-supplied fine-grained code on 409 ConflictException", () => {
    const { host, captured } = makeMockHost();
    filter.catch(
      new ConflictException({
        code: "alias_conflict",
        message: "tenant-wide alias already exists",
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.CONFLICT);
    const body = captured.body as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe("alias_conflict");
    expect(body.error.message).toBe("tenant-wide alias already exists");
    expect(typeof body.error.request_id).toBe("string");
  });

  // CP2 — bare string form → canonical fallback (no regression of EF5 behavior)
  it("CP2: falls back to canonical 'conflict' when no code is supplied (string form)", () => {
    const { host, captured } = makeMockHost();
    filter.catch(new ConflictException("Some message"), host);
    expect(captured.statusCode).toBe(HttpStatus.CONFLICT);
    const body = captured.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toBe("Some message");
  });

  // CP3 — structured 404 with user-supplied fine-grained code
  it("CP3: honors user-supplied code on 404 NotFoundException", () => {
    const { host, captured } = makeMockHost();
    filter.catch(
      new NotFoundException({
        code: "tenant_not_found",
        message: "Tenant gone",
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.NOT_FOUND);
    const body = captured.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("tenant_not_found");
    expect(body.error.message).toBe("Tenant gone");
  });

  // CP4 — ZodError path is independent; must keep returning validation_error
  it("CP4: ZodError remains 'validation_error' (unaffected by code-passthrough change)", () => {
    const { host, captured } = makeMockHost();
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    if (!result.success) {
      filter.catch(result.error, host);
    }
    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  // CP5 — both code and details surface from a structured throw
  it("CP5: structured throw with code + details → both surface on envelope", () => {
    const { host, captured } = makeMockHost();
    filter.catch(
      new ConflictException({
        code: "alias_conflict",
        message: "alias collision",
        details: { offending_alias: "abc", conflicting_item_id: "xyz" },
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.CONFLICT);
    const body = captured.body as {
      error: { code: string; message: string; details: unknown };
    };
    expect(body.error.code).toBe("alias_conflict");
    expect(body.error.message).toBe("alias collision");
    expect(body.error.details).toEqual({
      offending_alias: "abc",
      conflicting_item_id: "xyz",
    });
  });
});
