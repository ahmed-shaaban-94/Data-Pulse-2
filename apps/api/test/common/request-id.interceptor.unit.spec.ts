/**
 * request-id.interceptor.unit.spec.ts
 *
 * Docker-free unit coverage for RequestIdInterceptor.
 *
 * Strategy: mock `newId` from `@data-pulse-2/shared` to return a fixed UUID,
 * then drive all branches via different header configurations.
 *
 * Tests:
 *   RI1 – valid UUID in x-request-id header → honoured, set on request + response
 *   RI2 – invalid string in x-request-id header → newId() used instead
 *   RI3 – no x-request-id header → newId() called
 *   RI4 – array header with valid UUID as first element → first element used
 *   RI5 – empty string in x-request-id → newId() called (fails UUID_RE)
 *   RI6 – requestId is set on request.requestId
 *   RI7 – X-Request-Id response header is set to the requestId
 */
import "reflect-metadata";

import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";

// ---------------------------------------------------------------------------
// Module mock — must be before any import that pulls @data-pulse-2/shared.
// NOTE: jest.mock factories are hoisted, so we CANNOT reference local variables
// defined above. Use a literal value here; GENERATED_ID below mirrors it.
// ---------------------------------------------------------------------------

jest.mock("@data-pulse-2/shared", () => ({
  newId: jest.fn().mockReturnValue("00000000-0000-7000-8000-000000000099"),
}));

const GENERATED_ID = "00000000-0000-7000-8000-000000000099";

import { newId } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface FakeResponse {
  setHeader: jest.Mock;
}

function makeCtx(req: FakeRequest, res: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

const VALID_UUID_V7 = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
const VALID_UUID_V4 = "9f1a2b3c-4d5e-4f6a-8b7c-0d1e2f3a4b5c";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RequestIdInterceptor – unit", () => {
  let interceptor: RequestIdInterceptor;
  const nextHandler: CallHandler = { handle: () => of(null) };

  beforeEach(() => {
    interceptor = new RequestIdInterceptor();
    (newId as jest.Mock).mockClear();
    (newId as jest.Mock).mockReturnValue(GENERATED_ID);
  });

  // RI1: valid UUID in x-request-id header → honoured
  it("RI1: valid UUID in header → used as requestId, set on request and response", async () => {
    const req: FakeRequest = { headers: { "x-request-id": VALID_UUID_V7 } };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    expect(req.requestId).toBe(VALID_UUID_V7);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", VALID_UUID_V7);
    expect(newId).not.toHaveBeenCalled();
  });

  // RI2: invalid string in x-request-id → newId() used
  it("RI2: invalid header string → newId() generates the requestId", async () => {
    const req: FakeRequest = { headers: { "x-request-id": "not-a-uuid" } };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    expect(newId).toHaveBeenCalledTimes(1);
    expect(req.requestId).toBe(GENERATED_ID);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", GENERATED_ID);
  });

  // RI3: no x-request-id header → newId() called
  it("RI3: no header → newId() called and generated ID used", async () => {
    const req: FakeRequest = { headers: {} };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    expect(newId).toHaveBeenCalledTimes(1);
    expect(req.requestId).toBe(GENERATED_ID);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", GENERATED_ID);
  });

  // RI4: array header with valid UUID as first element → first element used
  it("RI4: array header with valid UUID as first element → first element used", async () => {
    const req: FakeRequest = {
      headers: { "x-request-id": [VALID_UUID_V7, "extra-ignored"] },
    };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    expect(req.requestId).toBe(VALID_UUID_V7);
    expect(newId).not.toHaveBeenCalled();
  });

  // RI5: empty string in x-request-id → fails UUID_RE → newId() called
  it("RI5: empty string header → newId() called", async () => {
    const req: FakeRequest = { headers: { "x-request-id": "" } };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    expect(newId).toHaveBeenCalledTimes(1);
    expect(req.requestId).toBe(GENERATED_ID);
  });

  // RI6: requestId is set on request.requestId (also valid UUID v4)
  it("RI6: requestId set on request object (v4 UUID honoured)", async () => {
    const req: FakeRequest = { headers: { "x-request-id": VALID_UUID_V4 } };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    expect(req.requestId).toBe(VALID_UUID_V4);
    expect(req.requestId).toMatch(UUID_RE);
  });

  // RI7: X-Request-Id response header is set to the requestId
  it("RI7: X-Request-Id response header echoes the requestId", async () => {
    const req: FakeRequest = { headers: {} };
    const res: FakeResponse = { setHeader: jest.fn() };

    await lastValueFrom(interceptor.intercept(makeCtx(req, res), nextHandler));

    const [[headerName, headerValue]] = res.setHeader.mock.calls as [[string, string]];
    expect(headerName).toBe("X-Request-Id");
    expect(headerValue).toBe(req.requestId);
  });
});
