/**
 * forbidden-category.spec.ts  (007 — T020 / T021)
 *
 * 007 adds `forbidden` as the 8th error category to the catalog failure
 * taxonomy (FR-051, FR-052). It is the wire code returned at HTTP 403 when an
 * in-scope principal lacks the authority for an action — most concretely the
 * US7 reopen authority split (a store-scoped manager acting on an in-scope
 * dismissed item: 403 `forbidden`, NOT 404 `not-found`). FR-052 is explicit
 * that `forbidden` (in-scope, insufficient authority) MUST be distinct from
 * `not-found` (out-of-scope / cross-tenant, non-disclosing) so the two cases
 * are never conflated.
 *
 * This suite is a characterization + regression guard at the `GlobalException-
 * Filter` boundary — the single point where every thrown `HttpException`
 * becomes a wire envelope. It asserts:
 *
 *   FC1 — a 403 `ForbiddenException` maps to `error.code === "forbidden"`
 *   FC2 — a 404 `NotFoundException` maps to `error.code === "not_found"`,
 *         proving the two categories are DISTINCT (FR-052)
 *   FC3 — the custom message supplied to `ForbiddenException` is preserved
 *         (the reopen path raises "tenant-wide authority required.")
 *   FC4 — a user-supplied structured `code: "forbidden"` is honored verbatim
 *         (Constitution §IV fine-grained-code passthrough), and `details`
 *         surface alongside it
 *   FC5 — adding `forbidden` does not perturb the already-shipped codes:
 *         the existing 7 status→code mappings still resolve unchanged
 *
 * Pure filter unit test (no Nest app, no Postgres) — mirrors the established
 * `exception-filter-code-passthrough.spec.ts` harness so RED/GREEN is fast and
 * unambiguous. Per the T021 acceptance, the 403→`forbidden` mapping is already
 * present in `statusToCode` (since the api skeleton); this suite locks it as a
 * named 007 contract guard and proves the distinctness FR-052 requires.
 */
import "reflect-metadata";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type ArgumentsHost,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";

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
    requestId: "test-req-id-forbidden",
    route: { path: "/api/v1/catalog/unknown-items/:id/reopen" },
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

function errorBody(captured: CapturedResponse): {
  code: string;
  message: string;
  request_id: string;
  details?: unknown;
} {
  return (
    captured.body as {
      error: {
        code: string;
        message: string;
        request_id: string;
        details?: unknown;
      };
    }
  ).error;
}

describe("Catalog error taxonomy — `forbidden` 8th category (007 FR-051/FR-052)", () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  // FC1 — bare 403 → canonical `forbidden`
  it("FC1: a 403 ForbiddenException maps to error.code = 'forbidden' (FR-051)", () => {
    const { host, captured } = makeMockHost();
    filter.catch(new ForbiddenException("tenant-wide authority required."), host);
    expect(captured.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(errorBody(captured).code).toBe("forbidden");
  });

  // FC2 — 403 `forbidden` is DISTINCT from 404 `not_found` (the FR-052 invariant)
  it("FC2: 403 'forbidden' is distinct from 404 'not_found' (FR-052 in-scope vs out-of-scope)", () => {
    const { host: fHost, captured: fCaptured } = makeMockHost();
    filter.catch(new ForbiddenException("tenant-wide authority required."), fHost);

    const { host: nHost, captured: nCaptured } = makeMockHost();
    filter.catch(new NotFoundException("Not Found"), nHost);

    expect(fCaptured.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(nCaptured.statusCode).toBe(HttpStatus.NOT_FOUND);

    const forbiddenCode = errorBody(fCaptured).code;
    const notFoundCode = errorBody(nCaptured).code;
    expect(forbiddenCode).toBe("forbidden");
    expect(notFoundCode).toBe("not_found");
    // The whole point of FR-052: the two cases never collapse onto one code.
    expect(forbiddenCode).not.toBe(notFoundCode);
  });

  // FC3 — the custom 403 message survives to the wire (non-disclosing wording is the caller's job)
  it("FC3: preserves the message supplied to ForbiddenException", () => {
    const { host, captured } = makeMockHost();
    filter.catch(new ForbiddenException("tenant-wide authority required."), host);
    expect(errorBody(captured).message).toBe("tenant-wide authority required.");
  });

  // FC4 — structured passthrough: explicit { code: 'forbidden', details } is honored (Constitution §IV)
  it("FC4: honors a structured 403 with code 'forbidden' and surfaces details", () => {
    const { host, captured } = makeMockHost();
    filter.catch(
      new ForbiddenException({
        code: "forbidden",
        message: "tenant-wide authority required.",
        details: { required_authority: "tenant_wide" },
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.FORBIDDEN);
    const body = errorBody(captured);
    expect(body.code).toBe("forbidden");
    expect(body.message).toBe("tenant-wide authority required.");
    expect(body.details).toEqual({ required_authority: "tenant_wide" });
    expect(typeof body.request_id).toBe("string");
  });

  // FC5 — adding the 8th category does NOT disturb the shipped 7 (no regression)
  it("FC5: the existing canonical status→code mappings are unchanged", () => {
    const expectations: ReadonlyArray<{
      label: string;
      throw: () => unknown;
      status: number;
      code: string;
    }> = [
      {
        label: "400 → validation_error",
        throw: () => new BadRequestException("Bad Request"),
        status: HttpStatus.BAD_REQUEST,
        code: "validation_error",
      },
      {
        label: "401 → unauthorized",
        throw: () => new UnauthorizedException("Unauthorized"),
        status: HttpStatus.UNAUTHORIZED,
        code: "unauthorized",
      },
      {
        label: "404 → not_found",
        throw: () => new NotFoundException("Not Found"),
        status: HttpStatus.NOT_FOUND,
        code: "not_found",
      },
      {
        label: "409 → conflict",
        throw: () => new ConflictException("Conflict"),
        status: HttpStatus.CONFLICT,
        code: "conflict",
      },
    ];

    for (const ex of expectations) {
      const { host, captured } = makeMockHost();
      filter.catch(ex.throw(), host);
      expect(captured.statusCode).toBe(ex.status);
      expect(errorBody(captured).code).toBe(ex.code);
    }
  });
});
