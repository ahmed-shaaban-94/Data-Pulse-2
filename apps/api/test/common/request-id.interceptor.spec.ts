import { ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface FakeResponse {
  setHeader: jest.Mock<void, [string, string]>;
}

function makeContext(req: FakeRequest, res: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe("RequestIdInterceptor", () => {
  let interceptor: RequestIdInterceptor;

  beforeEach(() => {
    interceptor = new RequestIdInterceptor();
  });

  it("mints a UUIDv7 when no inbound header is present", async () => {
    const req: FakeRequest = { headers: {} };
    const res: FakeResponse = { setHeader: jest.fn() };
    const ctx = makeContext(req, res);

    await lastValueFrom(
      interceptor.intercept(ctx, { handle: () => of(undefined) }),
    );

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", req.requestId);
  });

  it("honours an inbound UUID v7 header", async () => {
    const inbound = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
    const req: FakeRequest = { headers: { "x-request-id": inbound } };
    const res: FakeResponse = { setHeader: jest.fn() };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    expect(req.requestId).toBe(inbound);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", inbound);
  });

  it("honours an inbound UUID v4 header", async () => {
    const inbound = "9f1a2b3c-4d5e-4f6a-8b7c-0d1e2f3a4b5c";
    const req: FakeRequest = { headers: { "x-request-id": inbound } };
    const res: FakeResponse = { setHeader: jest.fn() };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    expect(req.requestId).toBe(inbound);
  });

  it("rejects malformed inbound header and mints a fresh UUID", async () => {
    const req: FakeRequest = {
      headers: { "x-request-id": "not-a-uuid" },
    };
    const res: FakeResponse = { setHeader: jest.fn() };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    expect(req.requestId).not.toBe("not-a-uuid");
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("uses the first value when the header is delivered as an array", async () => {
    const req: FakeRequest = {
      headers: {
        "x-request-id": ["018f3b1d-7c2a-7e3a-9bcd-0123456789ab", "extra"],
      },
    };
    const res: FakeResponse = { setHeader: jest.fn() };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    expect(req.requestId).toBe("018f3b1d-7c2a-7e3a-9bcd-0123456789ab");
  });

  it("passes through the underlying observable", async () => {
    const req: FakeRequest = { headers: {} };
    const res: FakeResponse = { setHeader: jest.fn() };
    const value = await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of("downstream-value"),
      }),
    );
    expect(value).toBe("downstream-value");
  });
});
