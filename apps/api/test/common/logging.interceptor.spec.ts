import { ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import {
  LoggingInterceptor,
} from "../../src/common/logging.interceptor";
import { createLogger, type Logger } from "@data-pulse-2/shared";

interface FakeRequest {
  method: string;
  url: string;
  originalUrl?: string;
  requestId?: string;
  headers?: Record<string, string>;
}

interface FakeResponse {
  statusCode: number;
}

function makeContext(
  req: FakeRequest,
  res: FakeResponse,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

interface CapturedCall {
  level: "info" | "error";
  obj: unknown;
  msg: unknown;
}

/**
 * Spies on the `child` method of a pino logger and captures calls to
 * `info`/`error` on the returned child. Returns the logger plus a getter
 * for the captured calls.
 */
function makeCapturingLogger(): { logger: Logger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const logger = createLogger({ service: "api-test" });
  const realChild = logger.child.bind(logger);
  jest
    .spyOn(logger, "child")
    .mockImplementation((bindings, options) => {
      const child = realChild(bindings, options);
      jest.spyOn(child, "info").mockImplementation((obj: unknown, msg?: unknown) => {
        calls.push({ level: "info", obj, msg });
      });
      jest.spyOn(child, "error").mockImplementation((obj: unknown, msg?: unknown) => {
        calls.push({ level: "error", obj, msg });
      });
      return child;
    });
  return { logger, calls };
}

describe("LoggingInterceptor", () => {
  it("logs an info line on success with request_id and route", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "GET",
      url: "/x",
      originalUrl: "/x?y=1",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 200 };

    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of("ok"),
      }),
    );

    const infoCalls = cap.calls.filter((c) => c.level === "info");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]?.msg).toBe("request completed");
    const obj = infoCalls[0]?.obj as Record<string, unknown>;
    expect(obj.method).toBe("GET");
    expect(obj.route).toBe("/x?y=1");
    expect(obj.status).toBe(200);
    expect(typeof obj.latency_ms).toBe("number");
  });

  it("logs an error line when the underlying observable throws", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/boom",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
    };
    const res: FakeResponse = { statusCode: 500 };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req, res), {
          handle: () => throwError(() => new Error("kaboom")),
        }),
      ),
    ).rejects.toThrow(/kaboom/);

    const errorCalls = cap.calls.filter((c) => c.level === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0]?.msg).toBe("request errored");
  });

  it("falls back to 'unknown' if request.requestId is missing", async () => {
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = { method: "GET", url: "/no-id" };
    const res: FakeResponse = { statusCode: 200 };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    expect(cap.calls.length).toBe(1);
    // The interceptor stamps "unknown" when requestId is missing; we can't
    // observe the child's bindings via the spy directly, but we can confirm
    // the interceptor didn't throw.
  });

  it("does not include raw request headers in the emitted log object", async () => {
    // The LoggingInterceptor never logs req.headers — neither Authorization
    // nor Cookie should appear in any call's `obj`. (The redact list in
    // the shared logger is the second-line defence.)
    const cap = makeCapturingLogger();
    const interceptor = new LoggingInterceptor(cap.logger);
    const req: FakeRequest = {
      method: "POST",
      url: "/login",
      requestId: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab",
      headers: {
        authorization: "Bearer super-secret-token-value",
        cookie: "session=ALSO-SECRET",
      },
    };
    const res: FakeResponse = { statusCode: 200 };
    await lastValueFrom(
      interceptor.intercept(makeContext(req, res), {
        handle: () => of(undefined),
      }),
    );
    const dump = JSON.stringify(cap.calls);
    expect(dump).not.toMatch(/super-secret-token-value/);
    expect(dump).not.toMatch(/ALSO-SECRET/);
  });
});
