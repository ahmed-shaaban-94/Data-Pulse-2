import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

interface FakeRequest {
  requestId?: string;
}

interface FakeResponse {
  status: jest.Mock;
  json: jest.Mock;
}

function makeHost(req: FakeRequest, captured: CapturedResponse): {
  host: ArgumentsHost;
  res: FakeResponse;
} {
  const res: FakeResponse = {
    status: jest.fn(function status(code: number) {
      captured.statusCode = code;
      return res;
    }),
    json: jest.fn(function json(body: unknown) {
      captured.body = body;
      return res;
    }),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

const REQ_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";

describe("GlobalExceptionFilter", () => {
  it("formats a NotFoundException as a 404 envelope", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new NotFoundException("Tenant not found"), host);

    expect(captured.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(captured.body).toEqual({
      error: {
        code: "not_found",
        message: "Tenant not found",
        request_id: REQ_ID,
      },
    });
  });

  it("formats a ForbiddenException with the same envelope shape as a 404", () => {
    // FR-ISO-4: 403 and 404 share envelope shape.
    const filter = new GlobalExceptionFilter();
    const a: CapturedResponse = {};
    const b: CapturedResponse = {};
    filter.catch(
      new ForbiddenException("nope"),
      makeHost({ requestId: REQ_ID }, a).host,
    );
    filter.catch(
      new NotFoundException("nope"),
      makeHost({ requestId: REQ_ID }, b).host,
    );
    expect(Object.keys((a.body as { error: object }).error).sort()).toEqual(
      Object.keys((b.body as { error: object }).error).sort(),
    );
  });

  it("includes details when HttpException response carries them", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(
      new BadRequestException({
        message: "validation failed",
        details: { field: "email" },
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as {
      error: { code: string; details?: unknown };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details).toEqual({ field: "email" });
  });

  it("formats a ZodError as 400 with issues in details", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    const zodResult = z.object({ x: z.string() }).safeParse({ x: 42 });
    if (zodResult.success) throw new Error("expected zod failure");
    filter.catch(zodResult.error, host);

    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as {
      error: { code: string; details?: unknown[] };
    };
    expect(body.error.code).toBe("validation_error");
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it("formats unknown errors as 500 with a generic message (no internal leak)", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(
      new Error("DB connection refused: secret-internal-detail"),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = captured.body as { error: { message: string; code: string } };
    expect(body.error.code).toBe("internal_error");
    // No leakage of internal error message.
    expect(body.error.message).toBe("Internal Server Error");
  });

  it("mints a fresh request_id when the request is missing one", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({}, captured);
    filter.catch(new NotFoundException(), host);
    const body = captured.body as { error: { request_id: string } };
    expect(body.error.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("envelope shape always has exactly { error: { code, message, request_id } } at minimum", () => {
    const filter = new GlobalExceptionFilter();
    const captured: CapturedResponse = {};
    const { host } = makeHost({ requestId: REQ_ID }, captured);
    filter.catch(new HttpException("x", HttpStatus.UNAUTHORIZED), host);
    expect(captured.body).toMatchObject({
      error: {
        code: "unauthorized",
        message: "x",
        request_id: REQ_ID,
      },
    });
    expect(Object.keys(captured.body as object)).toEqual(["error"]);
  });
});
